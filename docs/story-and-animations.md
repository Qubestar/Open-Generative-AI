# Story and Animations

## Create a video

1. Open **Story** for a narrated doodle explainer, or **Animations** for a motion treatment.
2. In Animations, choose **Editorial collage**, **Documentary maps**, or **Paper stop-motion**. These are three styles; landscape/portrait and short/long duration are separate choices.
3. Enter the topic and direction. Story can also start from a selected Google Sheets row: connect Google, choose the spreadsheet and worksheet, load rows, and choose the idea. A shared Viewer link is another option. Imported text remains editable and Vidmyo does not write to the sheet.
4. Choose orientation, target duration, language, and narration. Kokoro provides local English narration. ElevenLabs uses the saved API key for multilingual narration, including Polish.
5. Choose a connected local director in **Agents**, or specify an OpenRouter model. Image generation uses the separately selected image provider and its key in **Settings**. Documentary maps use bundled geography and need no generated images.
6. Optionally enable **Review script** or **Review voiceover**. Leave both off for automatic production.
7. Choose the parent folder and create the project. Vidmyo creates a unique subfolder, then **Create video** starts production. Any paid-provider confirmation describes the selected services before requests begin.

Narrated duration follows the complete generated recording. The requested duration guides script length; it is not a promise to stretch or cut the voice to an exact length.

## Continue existing work

**Open existing** selects a project folder containing `project.json`. **Recent work** opens the same folder directly. The project stores its brief, approvals, generated assets, and progress. After an interruption, continue from saved work. Provider failures remain visible; they do not report a finished video.

Edit the brief and save before continuing. Changed script or visual instructions can invalidate later work. Completed assets are retained when the saved specification still matches, avoiding unnecessary regeneration.

## Reference styles

The supplied animation folder contains three visual systems:

| Treatment | Source | Interpretation |
| --- | --- | --- |
| Editorial collage | `empire-downfall-project-pack` | Paper, photographic cutouts, red accents, foreground motion |
| Documentary maps | `skool-practice-kit` | Real geography, locations, routes, moving camera |
| Paper stop-motion | Premium Paper Stop-Motion DOCX prompt | Cardstock layers assemble, followed by subtle poster motion |

The two supplied movies are short landscape examples. Long form and short form are not duplicate animation types. Vidmyo uses original compositions; the practice kit's restricted media is not redistributed.

## Desktop and credentials

Project folders, local agents, narration, and rendering run in Vidmyo desktop. The browser can display the intake but cannot access these desktop functions. Restart the desktop process after updating Electron code.

API keys stay in global Settings and are not stored in project manifests. Google account setup on a clean installation has separate prerequisites; see [Google Sheets connection](google-sheets-connection.md). No Google account or key is copied from the developer's machine into a release.
