"""Public citation URL checks shared with the website route rules."""

from __future__ import annotations

import re

DOCUMENT_TYPES = frozenset({"profile", "experience", "project", "background"})
_ID_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_ROUTE_PREFIX = {
    "profile": "/profile/",
    "experience": "/experience/",
    "project": "/work/",
    "background": "/background/",
}


def is_public_citation_url(url: str, document_type: str) -> bool:
    """Accept a same-site citation route for the document type.

    The path is ``/{profile|experience|work|background}/{id}#{slug}``.
    External, protocol-relative, and S3 locations are rejected.
    """
    prefix = _ROUTE_PREFIX.get(document_type)
    if prefix is None or not url.startswith(prefix) or url.startswith("//"):
        return False
    if any(character.isspace() or character == "\\" for character in url):
        return False
    lowered = url.lower()
    if "javascript:" in lowered or "://" in lowered or lowered.startswith("s3:"):
        return False
    path, separator, fragment = url.partition("#")
    if separator != "#" or not _ID_PATTERN.fullmatch(fragment):
        return False
    document_id = path.removeprefix(prefix)
    return _ID_PATTERN.fullmatch(document_id) is not None
