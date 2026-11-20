# Emote

Play one brief visual animation on the calling agent's avatar. Does not take or move the real cursor, capture the screen, or impersonate another agent.

1. Place your own avatar with `computer` op `point` first.
2. Call `emote` with `animation`: `spin`, `hyper`, `laugh`, `cry`, `celebrate`, or `angry` (a quick side-to-side shake of the whole flower with the angry face).
3. Optional `reason` (up to 200 characters) is a public caption. Omit your name; the overlay supplies it. Never include private reasoning or secrets.

Animations last 1.2–2 seconds, then stop. Repeating the same call replays it. OS reduced-motion preference disables the added movement. A missing avatar position returns `ok:false` and asks for `point` first. Success means the visual event was emitted, not that its appearance was independently verified.

You can also set any of the 13 expressions without movement using `emotion`, or combine `emotion` and `animation`. At least one is required. Expressions: neutral, happy, thinking, focused, curious, surprised, sleepy, worried, proud, stumped, angry, embarrassed, annoyed. Cry temporarily overrides the face with large eyes and a frown; celebrate adds confetti.

Expression `angry` frowns with sharp brows and a red flush and shakes gently on its own; animation `angry` adds a stronger one-off shake on top. `embarrassed` has wide eyes glancing away, a small mouth and big rosy cheeks. `annoyed` rolls its eyes up and around, with a flat mouth. With OS reduced motion on, all three hold a still pose.
