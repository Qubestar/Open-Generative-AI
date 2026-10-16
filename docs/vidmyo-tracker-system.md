# Vidmyo tracker system

## Product position

Vidmyo should sell a complete production system rather than a blank video editor. A customer receives:

- the desktop production app;
- the licensed Google Flow extension;
- a ready-to-copy Vidmyo Tracker for planning and production state;
- channel presets for long-form and short-form work;
- updates to the production recipes and tracker contract.

The tracker is the shared control surface between a person, local agents and the desktop app. The app reads planning fields, creates local projects and later can write explicitly approved production results back to the same row.

## Doodle 1 contract

The existing Doodle 1 system uses this exact 21-column order:

1. Status
2. Video #
3. Working Title
4. Hook
5. Topic / Angle
6. Script
7. Voiceover
8. Images
9. MP4 File
10. Description
11. Tags
12. Hashtags
13. Thumbnail
14. Publish Date
15. YouTube Link
16. Notes
17. Agent
18. Claimed (UTC)
19. Drive File ID
20. Optimized (AI label/cards)
21. Thumbnail File ID

Vidmyo's intake should treat columns 1–5 as the minimum portable brief. Columns 6–21 are the production ledger. The current flexible header matcher remains useful for customer sheets, while the official template provides the full supported workflow.

## Packaging

### Starter

- Vidmyo desktop application
- one licensed device
- official long-form and short-form tracker templates
- local rendering and bring-your-own provider keys

### Creator

- more devices/channels
- licensed Flow queue extension
- maintained Story and Animations recipes
- tracker status synchronization and reusable channel presets

### Studio

- team seats and shared trackers
- centralized templates and policy controls
- audit history, priority support and higher queue-permit limits

Google Sheets remains owned by the customer. Vidmyo provides a versioned template and importer; the subscription grants the maintained automation, extension and recipe service. This avoids making a single copyable spreadsheet the product.

## Template lifecycle

1. Ship a versioned CSV template for immediate offline use and Google Sheets import.
2. Publish a View-only Google Sheet master with **Make a copy** onboarding.
3. Store `templateVersion` in Vidmyo's sheet configuration rather than adding a hidden column to customer content.
4. Detect missing or renamed headers and offer a non-destructive migration preview.
5. Never overwrite a customer's sheet or add write scopes without an explicit write action.

The bundled template lives at `assets/templates/vidmyo-video-tracker-v1.csv`.

The channel-level product and synchronization design is specified in `docs/channel-workspaces-and-content-planner.md`.
