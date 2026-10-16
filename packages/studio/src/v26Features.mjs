// Vidmyo V2.6 — top-level feature registry and the exact click path from the
// running app sidebar. Pure data, imported by `v26Reachability.test.js` (Node)
// and safe to import from the renderer (no DOM/Electron dependencies).
//
// Reachability contract: a feature is reachable only when its `sidebarTab`
// exists in StandaloneShell's TABS and the renderer branch for that tab is
// present. Dev-only `?panel=` routes never count. Features with no sidebar tab
// (`viaSettings: true`) must have their entry point inside SettingsModal.
//
// `markers` are { file, pattern, note } tuples the test asserts with a literal
// substring (never a regex) so the audit cannot silently drift from the code.

export const SIDEBAR_SHELL_FILE = 'components/StandaloneShell.js';
export const SETTINGS_FILE = 'packages/studio/src/components/SettingsModal.jsx';

export const V26_FEATURES = [
  {
    id: 'publisher',
    label: 'Auto-Publisher (YouTube Data API v3)',
    area: 1,
    sidebarTab: 'publisher',
    clickPath: 'Sidebar: Publish (also: Cleaner → review a project → Publisher queue at the bottom of the review panel)',
    markers: [
      { file: 'components/StandaloneShell.js', pattern: "activeTab === 'publisher' && <PublisherQueuePanel", note: 'dedicated Publish tab (kept by Luke 2026-09-26)' },
      { file: 'packages/studio/src/components/CleanerReview.jsx', pattern: '<PublisherQueuePanel', note: 'queue also rendered inside the real Cleaner review' },
      { file: 'packages/studio/src/components/PublisherQueuePanel.jsx', pattern: 'listQueue', note: 'queue reads the durable JobStore-persisted queue' },
    ],
  },
  {
    id: 'screen-studio',
    label: 'Screen Studio (real governed capture + Smart Auto-Zoom)',
    area: 2,
    sidebarTab: 'screen-studio',
    clickPath: 'Sidebar: Screen Studio',
    markers: [
      { file: 'packages/studio/src/components/ScreenStudio.jsx', pattern: 'data-testid="screen-studio-panel"', note: 'dedicated section root' },
      { file: 'packages/studio/src/components/ScreenStudio.jsx', pattern: 'data-testid="start-recording-btn"', note: 'real start control' },
    ],
  },
  {
    id: 'broll',
    label: 'Stock & B-roll Matcher (licence-enforced)',
    area: 3,
    sidebarTab: 'cleaner',
    clickPath: 'Sidebar: Cleaner → review a project → Auto-Editor → B-roll & Retention Suggestions',
    markers: [
      { file: 'packages/studio/src/components/AutoEditorPanel.jsx', pattern: 'B-roll & Retention Suggestions', note: 'B-roll matcher UI entry' },
    ],
  },
  {
    id: 'auto-editor',
    label: 'AI Auto-Editor & NLE Export',
    area: 4,
    sidebarTab: 'cleaner',
    clickPath: 'Sidebar: Cleaner → review a project → Auto-Editor (embedded in the review panel)',
    markers: [
      { file: 'packages/studio/src/components/CleanerReview.jsx', pattern: '<AutoEditorPanel', note: 'Auto-Editor is embedded in the real Cleaner review' },
      { file: 'packages/studio/src/components/AutoEditorPanel.jsx', pattern: 'exportNle', note: 'NLE export entry' },
    ],
  },
  {
    id: 'retention',
    label: 'Viral Retention & Dual-Hooks (hypothesis parameters)',
    area: 5,
    sidebarTab: 'cleaner',
    clickPath: 'Sidebar: Cleaner → review a project → Auto-Editor → hypothesis sliders',
    markers: [
      { file: 'packages/studio/src/components/AutoEditorPanel.jsx', pattern: 'mierzone, nie gwarantowane', note: 'hypothesis disclaimer, not a platform guarantee' },
    ],
  },
  {
    id: 'cartoon',
    label: 'Generative Anime & Cartoon Studio',
    area: 6,
    sidebarTab: 'marketing',
    clickPath: 'Sidebar: Marketing → 🎬 Cartoon Studio (workspace switcher)',
    markers: [
      { file: 'packages/studio/src/components/MarketingStudio.jsx', pattern: '<CartoonStudio', note: 'Cartoon Studio rendered by the real Marketing switcher' },
    ],
  },
  {
    id: 'avatar-2d-mascot',
    label: 'Avatar & Talking Head Studio (2D Mascot fallback)',
    area: 7,
    sidebarTab: 'marketing',
    clickPath: 'Sidebar: Marketing → V2.6 Promo & UGC Review Studio → 2D Mascot render',
    markers: [
      { file: 'packages/studio/src/components/PromoReviewStudio.jsx', pattern: 'handleTrigger2dMascot', note: '2D Mascot entry point' },
    ],
  },
  {
    id: 'promo-ads',
    label: 'Promo & Ads Studio',
    area: 8,
    sidebarTab: 'marketing',
    clickPath: 'Sidebar: Marketing → V2.6 Promo & UGC Review Studio',
    markers: [
      { file: 'packages/studio/src/components/MarketingStudio.jsx', pattern: '<PromoReviewStudio', note: 'Promo & Ads rendered by the real Marketing switcher' },
    ],
  },
  {
    id: 'review-ugc',
    label: 'Review & UGC Studio',
    area: 9,
    sidebarTab: 'marketing',
    clickPath: 'Sidebar: Marketing → V2.6 Promo & UGC Review Studio → claim verification / UGC scripts',
    markers: [
      { file: 'packages/studio/src/components/PromoReviewStudio.jsx', pattern: 'verifyClaims', note: 'UGC claim verification entry' },
    ],
  },
  {
    id: 'model-packages',
    label: 'Model packages manager (Kokoro TTS / Whisper ASR)',
    area: null,
    sidebarTab: null,
    viaSettings: true,
    clickPath: 'Sidebar: Settings (gear) → Engines & models',
    markers: [
      { file: SETTINGS_FILE, pattern: 'Engines & models', note: 'read-only Engines section in Settings' },
      { file: SETTINGS_FILE, pattern: 'modelPackagesStatus', note: 'reads engines:model-packages-status' },
    ],
  },
  {
    id: 'ffmpeg-capabilities',
    label: 'FFmpeg capability report',
    area: null,
    sidebarTab: null,
    viaSettings: true,
    clickPath: 'Sidebar: Settings (gear) → Engines & models → FFmpeg capabilities',
    markers: [
      { file: SETTINGS_FILE, pattern: 'ffmpegCapabilities', note: 'reads promo:ffmpeg-capabilities' },
    ],
  },
  {
    id: 'hyperframes-optin',
    label: 'HyperFrames renderer (opt-in)',
    area: null,
    sidebarTab: null,
    viaSettings: true,
    clickPath: 'Sidebar: Marketing → Promo / Cartoon renderer selector (HyperFrames opt-in), pin status in Settings → Engines & models',
    markers: [
      { file: 'packages/studio/src/components/PromoReviewStudio.jsx', pattern: 'renderer-select', note: 'FFmpeg default / HyperFrames opt-in selector' },
      { file: 'packages/studio/src/components/CartoonStudio.jsx', pattern: 'cartoon-renderer-select', note: 'Cartoon renderer selector' },
    ],
  },
];

// The nine INVENTORY areas, for a one-to-one audit of the target scope.
export const V26_AREA_IDS = V26_FEATURES.filter((f) => f.area !== null).map((f) => f.area).sort((a, b) => a - b);

export const SIDEBAR_TAB_IDS = [...new Set(V26_FEATURES.map((f) => f.sidebarTab).filter(Boolean))];
