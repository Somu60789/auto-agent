"""
OneDrive client — full file operations via Microsoft Graph API.
Token extracted from Windows Credential Manager (OneDrive sync client).
No Azure App Registration required.
"""

import os, json, logging, time
import httpx
import win32cred

log = logging.getLogger(__name__)
GRAPH = "https://graph.microsoft.com/v1.0"

# ---------------------------------------------------------------------------
# Token extraction — OneDrive sync client stores tokens in Credential Manager
# ---------------------------------------------------------------------------

def _get_onedrive_token() -> str | None:
    try:
        creds = win32cred.CredEnumerate(None, 0)
    except Exception:
        return None
    for cred in creds:
        target = cred.get("TargetName", "").lower()
        if not any(k in target for k in ["onedrive", "sharepoint", "microsoftoffice", "mso"]):
            continue
        blob = cred.get("CredentialBlob", b"")
        if not blob:
            continue
        for enc in ("utf-16-le", "utf-8"):
            try:
                data = json.loads(blob.decode(enc, errors="ignore"))
                token = data.get("access_token") or data.get("AccessToken")
                if token and len(token) > 100:
                    exp = float(data.get("expires_on", time.time() + 3600))
                    if exp > time.time() + 60:
                        return token
            except Exception:
                continue
    return None


def _headers(content_type: str = "application/json") -> dict:
    token = _get_onedrive_token()
    if not token:
        raise RuntimeError("No OneDrive token — is OneDrive sync client running and signed in?")
    return {"Authorization": f"Bearer {token}", "Content-Type": content_type}


def _drive_path(path: str) -> str:
    """Build Graph API path for a drive item by path."""
    return f"{GRAPH}/me/drive/root:/{path.lstrip('/')}"


# ---------------------------------------------------------------------------
# Upload (create or replace)
# ---------------------------------------------------------------------------

def upload_file(folder_path: str, filename: str, content: str) -> dict:
    """
    Upload text/HTML content as a file to OneDrive (single PUT, <4MB).
    folder_path: relative path under My Files, e.g. 'Reports/Weekly'
    filename:    e.g. 'weekly-report-2026-07-13.html'
    content:     file content as string
    """
    encoded = content.encode("utf-8")
    path    = f"{folder_path}/{filename}".lstrip("/")
    ct      = "text/html" if filename.endswith(".html") else "text/plain"
    url     = f"{_drive_path(path)}:/content"
    r = httpx.put(url, content=encoded, headers=_headers(ct), timeout=60)
    r.raise_for_status()
    data = r.json()
    log.info("Uploaded to OneDrive: %s → %s", path, data.get("webUrl", ""))
    return {
        "status":  "uploaded",
        "path":    path,
        "url":     data.get("webUrl", ""),
        "item_id": data.get("id", ""),
        "size":    len(encoded),
    }


# ---------------------------------------------------------------------------
# Download
# ---------------------------------------------------------------------------

def download_file(file_path: str) -> str:
    """
    Download a OneDrive file and return its text content.
    file_path: relative path under My Files, e.g. 'Documents/spec.md'
    """
    url = f"{_drive_path(file_path)}:/content"
    r   = httpx.get(url, headers=_headers(), timeout=60, follow_redirects=True)
    r.raise_for_status()
    return r.text


def download_file_bytes(file_path: str) -> bytes:
    """Download a binary file from OneDrive."""
    url = f"{_drive_path(file_path)}:/content"
    r   = httpx.get(url, headers=_headers(), timeout=60, follow_redirects=True)
    r.raise_for_status()
    return r.content


# ---------------------------------------------------------------------------
# List folder contents
# ---------------------------------------------------------------------------

def list_folder(folder_path: str = "") -> list[dict]:
    """
    List files and sub-folders in a OneDrive folder.
    folder_path: relative path, e.g. 'Reports' or '' for root.
    """
    if folder_path:
        url = f"{_drive_path(folder_path)}:/children"
    else:
        url = f"{GRAPH}/me/drive/root/children"
    r = httpx.get(url, headers=_headers(), timeout=30,
                  params={"$top": 200, "$select": "id,name,size,folder,file,lastModifiedDateTime,webUrl"})
    r.raise_for_status()
    items = []
    for f in r.json().get("value", []):
        items.append({
            "name":     f["name"],
            "type":     "folder" if "folder" in f else "file",
            "size":     f.get("size", 0),
            "modified": f.get("lastModifiedDateTime", ""),
            "url":      f.get("webUrl", ""),
            "id":       f["id"],
        })
    return items


# ---------------------------------------------------------------------------
# Get item metadata
# ---------------------------------------------------------------------------

def get_file_info(file_path: str) -> dict:
    """Get metadata for a OneDrive file or folder."""
    r = httpx.get(_drive_path(file_path), headers=_headers(), timeout=15)
    r.raise_for_status()
    d = r.json()
    return {
        "name":     d.get("name", ""),
        "id":       d.get("id", ""),
        "size":     d.get("size", 0),
        "modified": d.get("lastModifiedDateTime", ""),
        "url":      d.get("webUrl", ""),
        "type":     "folder" if "folder" in d else "file",
    }


# ---------------------------------------------------------------------------
# Move / rename
# ---------------------------------------------------------------------------

def move_file(src_path: str, dest_folder_path: str, new_name: str | None = None) -> dict:
    """
    Move a file to a different folder, optionally renaming it.
    src_path:        current path, e.g. 'Downloads/report.html'
    dest_folder_path: destination folder path, e.g. 'Reports/Archive'
    new_name:        rename during move (optional)
    """
    # Resolve destination folder ID
    dest_r = httpx.get(_drive_path(dest_folder_path), headers=_headers(), timeout=15)
    dest_r.raise_for_status()
    dest_id = dest_r.json()["id"]

    payload: dict = {"parentReference": {"id": dest_id}}
    if new_name:
        payload["name"] = new_name

    url = f"{_drive_path(src_path)}"
    r   = httpx.patch(url, headers=_headers(), timeout=30, json=payload)
    r.raise_for_status()
    d = r.json()
    log.info("Moved OneDrive file: %s → %s/%s", src_path, dest_folder_path, d.get("name"))
    return {"status": "moved", "name": d.get("name"), "url": d.get("webUrl", "")}


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------

def search_files(query: str, max_results: int = 20) -> list[dict]:
    """
    Search all OneDrive files by name or content keyword.
    Returns up to max_results matching items.
    """
    url = f"{GRAPH}/me/drive/root/search(q='{query}')"
    r   = httpx.get(url, headers=_headers(), timeout=30,
                    params={"$top": max_results,
                            "$select": "id,name,size,file,lastModifiedDateTime,webUrl,parentReference"})
    r.raise_for_status()
    return [
        {
            "name":     f["name"],
            "folder":   f.get("parentReference", {}).get("path", "").replace("/drive/root:", ""),
            "size":     f.get("size", 0),
            "modified": f.get("lastModifiedDateTime", ""),
            "url":      f.get("webUrl", ""),
            "id":       f["id"],
        }
        for f in r.json().get("value", [])
    ]


# ---------------------------------------------------------------------------
# Sharing
# ---------------------------------------------------------------------------

def create_share_link(item_path: str, link_type: str = "view") -> str:
    """
    Create a shareable link for a OneDrive file.
    link_type: 'view' (read-only) or 'edit'
    """
    url = f"{_drive_path(item_path)}:/createLink"
    r   = httpx.post(url, headers=_headers(), timeout=15,
                     json={"type": link_type, "scope": "organization"})
    r.raise_for_status()
    return r.json().get("link", {}).get("webUrl", "")


# ---------------------------------------------------------------------------
# Create folder
# ---------------------------------------------------------------------------

def create_folder(parent_path: str, folder_name: str) -> dict:
    """Create a new folder in OneDrive."""
    if parent_path:
        url = f"{_drive_path(parent_path)}:/children"
    else:
        url = f"{GRAPH}/me/drive/root/children"
    r = httpx.post(url, headers=_headers(), timeout=15,
                   json={"name": folder_name, "folder": {},
                         "@microsoft.graph.conflictBehavior": "rename"})
    r.raise_for_status()
    d = r.json()
    return {"status": "created", "name": d["name"], "id": d["id"], "url": d.get("webUrl", "")}
