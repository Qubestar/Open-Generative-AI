// Pure state machine, action reducers, and formatters for Screen Studio UI in Vidmyo V2.6.
// Phase 5, Step 5 (Checkpoint E).

import { newExportJobId, exportOutcome, isJobCancelled } from './exportCancelModel.mjs';

export { newExportJobId, exportOutcome, isJobCancelled };

export const SCREEN_STUDIO_MODES = {
  REAL: 'real',
  DEMO: 'demo',
};

export const SCREEN_STUDIO_STATUS = {
  IDLE: 'idle',
  CHECKING_PERMISSIONS: 'checking_permissions',
  PERMISSION_DENIED: 'permission_denied',
  STARTING_RECORDING: 'starting_recording',
  RECORDING: 'recording',
  STOPPING_RECORDING: 'stopping_recording',
  RECORDED: 'recorded',
  EXPORTING: 'exporting',
  EXPORTED: 'exported',
  ERROR: 'error',
};

export function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

export function formatBytes(bytes) {
  if (bytes === undefined || bytes === null || isNaN(bytes)) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function initialScreenStudioState(overrides = {}) {
  return {
    mode: SCREEN_STUDIO_MODES.REAL,
    status: SCREEN_STUDIO_STATUS.IDLE,
    permission: {
      granted: false,
      reason: null,
      canPrompt: true,
    },
    sources: {
      screens: [],
      audio: [],
      systemAudioSupported: false,
      displays: [],
    },
    selectedScreenIndex: 0,
    selectedAudioIndex: null,
    systemAudioEnabled: true,
    recording: {
      jobId: null,
      startedAtMs: null,
      elapsedSec: 0,
      governorBusy: false,
      heldBy: null,
    },
    recordedResult: null,
    preview: {
      dataUrl: null,
      isProxy: false,
      buildingProxy: false,
      tooLarge: false,
      error: null,
    },
    edgInfo: null,
    exportConfig: {
      aspect: '16:9',
      fps: 30,
      autoZoom: true,
      zoomSensitivity: 'medium',
      canvasPreset: 'NONE',
      micVolume: 1,
      systemVolume: 1,
      windowCornerRadius: 16,
      windowShadowBlur: 40,
    },
    exportJob: {
      jobId: null,
      outcome: null,
      outputPath: null,
      encoder: null,
    },
    error: null,
    ...overrides,
  };
}

export function screenStudioReducer(state, action) {
  switch (action.type) {
    case 'SET_MODE':
      return { ...state, mode: action.mode };
    case 'SET_PERMISSION': {
      const isGranted = Boolean(action.granted ?? action.authorized);
      return {
        ...state,
        permission: {
          granted: isGranted,
          reason: action.reason || null,
          canPrompt: action.canPrompt ?? true,
        },
        status: isGranted
          ? (state.status === SCREEN_STUDIO_STATUS.PERMISSION_DENIED ? SCREEN_STUDIO_STATUS.IDLE : state.status)
          : SCREEN_STUDIO_STATUS.PERMISSION_DENIED,
      };
    }
    case 'SET_SOURCES': {
      const screens = action.screens || [];
      const audio = action.audio || [];
      // The first enumerated screen is not necessarily index 0 (on this host a
      // camera enumerates as index 0 and "Capture screen 0" is index 1). When
      // the current selection is not in the fresh list, adopt the first real
      // screen so Record never targets a stale/unknown device.
      const currentIndex = Number(state.selectedScreenIndex);
      const isInList = screens.some((s) => Number(s.index) === currentIndex);
      const selectedScreenIndex = screens.length > 0 && !isInList
        ? Number(screens[0].index)
        : state.selectedScreenIndex;
      // Preselect the system default microphone the first time sources load.
      const defaultMic = audio.find((a) => a.isDefault);
      const selectedAudioIndex = state.selectedAudioIndex === null && defaultMic
        ? Number(defaultMic.index)
        : state.selectedAudioIndex;
      return {
        ...state,
        sources: {
          screens,
          audio,
          systemAudioSupported: Boolean(action.systemAudioSupported),
          displays: action.displays || [],
        },
        selectedScreenIndex,
        selectedAudioIndex,
      };
    }
    case 'SELECT_SCREEN':
      return { ...state, selectedScreenIndex: Number(action.screenIndex) || 0 };
    case 'SELECT_AUDIO':
      return { ...state, selectedAudioIndex: action.audioIndex };
    case 'TOGGLE_SYSTEM_AUDIO':
      return { ...state, systemAudioEnabled: Boolean(action.enabled) };
    case 'START_RECORDING_REQUEST':
      return { ...state, status: SCREEN_STUDIO_STATUS.STARTING_RECORDING, error: null };
    case 'START_RECORDING_SUCCESS':
      return {
        ...state,
        status: SCREEN_STUDIO_STATUS.RECORDING,
        recording: {
          jobId: action.jobId,
          startedAtMs: action.startedAtMs || Date.now(),
          elapsedSec: 0,
          governorBusy: false,
          heldBy: null,
        },
        error: null,
      };
    case 'START_RECORDING_FAILURE':
      return {
        ...state,
        status: SCREEN_STUDIO_STATUS.ERROR,
        error: action.error || 'Nie udało się rozpocząć nagrywania',
      };
    case 'UPDATE_TIMER':
      return {
        ...state,
        recording: {
          ...state.recording,
          elapsedSec: action.elapsedSec,
        },
      };
    case 'UPDATE_GOVERNOR_STATUS':
      return {
        ...state,
        recording: {
          ...state.recording,
          governorBusy: Boolean(action.governorBusy),
          heldBy: action.heldBy || null,
        },
      };
    case 'STOP_RECORDING_REQUEST':
      return { ...state, status: SCREEN_STUDIO_STATUS.STOPPING_RECORDING };
    case 'STOP_RECORDING_SUCCESS':
      return {
        ...state,
        status: SCREEN_STUDIO_STATUS.RECORDED,
        recordedResult: action.result,
        edgInfo: null,
        preview: {
          dataUrl: action.result?.dataUrl || null,
          micDataUrl: action.result?.micDataUrl || null,
          isProxy: false,
          buildingProxy: false,
          tooLarge: Boolean(action.result?.tooLarge),
          error: null,
        },
        error: null,
      };
    case 'STOP_RECORDING_FAILURE':
      return {
        ...state,
        status: SCREEN_STUDIO_STATUS.ERROR,
        error: action.error || 'Błąd podczas zatrzymywania nagrywania',
      };
    case 'CANCEL_RECORDING_SUCCESS':
      return {
        ...state,
        status: SCREEN_STUDIO_STATUS.IDLE,
        recording: { jobId: null, startedAtMs: null, elapsedSec: 0, governorBusy: false, heldBy: null },
        recordedResult: null,
        preview: { dataUrl: null, isProxy: false, buildingProxy: false, tooLarge: false },
        error: null,
      };
    case 'CANCEL_RECORDING_FAILURE':
      return {
        ...state,
        status: SCREEN_STUDIO_STATUS.ERROR,
        error: action.code ? `${action.error} (${action.code})` : (action.error || 'Nie udało się anulować nagrywania'),
      };
    case 'SET_PREVIEW_BUILDING':
      return {
        ...state,
        preview: { ...state.preview, buildingProxy: Boolean(action.building), error: null },
      };
    case 'SET_PREVIEW_ERROR':
      return {
        ...state,
        preview: { ...state.preview, buildingProxy: false, error: action.error || 'Nie udało się zbudować podglądu proxy' },
      };
    case 'SET_PROXY_PREVIEW':
      return {
        ...state,
        preview: {
          dataUrl: action.dataUrl,
          isProxy: true,
          buildingProxy: false,
          tooLarge: false,
          error: null,
        },
      };
    case 'SET_EDG_INFO':
      return {
        ...state,
        edgInfo: action.info || null,
      };
    case 'UPDATE_EXPORT_CONFIG':
      return {
        ...state,
        exportConfig: {
          ...state.exportConfig,
          ...action.config,
        },
      };
    case 'START_EXPORT_REQUEST':
      return {
        ...state,
        status: SCREEN_STUDIO_STATUS.EXPORTING,
        exportJob: {
          jobId: action.jobId,
          outcome: null,
          outputPath: null,
          encoder: null,
        },
        error: null,
      };
    case 'EXPORT_FINISHED':
      return {
        ...state,
        status: action.outcome?.state === 'done' ? SCREEN_STUDIO_STATUS.EXPORTED : SCREEN_STUDIO_STATUS.RECORDED,
        exportJob: {
          jobId: action.jobId || state.exportJob.jobId,
          outcome: action.outcome,
          outputPath: action.outcome?.outputPath || null,
          encoder: action.outcome?.encoder || null,
        },
        error: action.outcome?.state === 'error' ? action.outcome.message : null,
      };
    case 'RESET':
      return initialScreenStudioState({
        sources: state.sources,
        permission: state.permission,
      });
    default:
      return state;
  }
}
