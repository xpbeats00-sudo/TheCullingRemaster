# Discord presence art

While the game runs, the launcher sets a Discord Rich Presence
(`lib/discord.js`). Discord then shows "Playing The Culling Remaster" with the
mask art in place of an unknown game's "?". The name and art come from a
Discord application:

1. Go to https://discord.com/developers/applications, choose **New Application**
   and name it **The Culling Remaster**. Discord shows this name after "Playing".
2. Under **General Information**, set the **App Icon** to `mask-1024.png`.
3. Under **Rich Presence → Art Assets**, add `mask-1024.png` and name it
   **mask** (`ASSET` in `lib/discord.js`). New assets can take a few minutes
   to appear.
4. Copy the **Application ID** from General Information into `APP_ID` in
   `lib/discord.js`. The ID is public, not a secret. While `APP_ID` is empty,
   the presence is off.

`mask-1024-transparent.png` is the same art without the dark background.
