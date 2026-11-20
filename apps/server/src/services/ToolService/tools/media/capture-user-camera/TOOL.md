# Capture User Camera

Take one fresh webcam frame from an active Vision Mode session when the current
request requires camera context. No frame exists before this call and no
periodic camera capture runs in the background.

The frame comes from the Snaglet window that granted camera access (the same bridge
the screen tool uses), so it works the same on macOS and Windows and needs no
native helper. The frame is attached only to the current turn and deleted at
teardown. A repeated screen or camera capture in the same turn reuses the one
allowed frame.

If the capture fails, the error names exactly one cause and its remedy: vision
access off, camera not granted, permission denied by the operating system, no
camera found, camera busy in another application, the granted stream ended,
the window did not answer in time, or the window is no longer connected. Relay
that message to the user instead of retrying blindly; every one of them is
fixed by the user re-enabling camera access in the composer.
