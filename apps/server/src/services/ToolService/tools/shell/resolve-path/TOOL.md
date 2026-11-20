# Resolve Path

Use `domain: "workspace"` for Snaglet doc/container paths and `domain:
"filesystem"` for OS paths. The workspace mode returns node metadata without
loading document content. Filesystem mode expands `~`, resolves relative paths,
and reports whether the target is a file, directory, or missing.
