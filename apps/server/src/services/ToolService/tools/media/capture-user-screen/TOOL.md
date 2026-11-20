# Capture User Screen

Take one fresh screen frame from an active Vision Mode session when the current
request actually requires visual context. Enabling Vision Mode grants access;
it does not capture anything until this tool is called.

The returned `temporary_frame_id` and pixels exist only for the current agent
turn. A repeated call in the same turn reuses that frame. Snaglet deletes it during
to save the frame permanently.

Optional selectors target a display, window, or `x,y,width,height` region.
