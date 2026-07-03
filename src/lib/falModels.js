// fal.ai model catalog for Vidmyo. These are shaped to match the studio's
// v2vModels (video-to-video "tools" mode) so the existing picker + upload flow
// work unchanged. `provider: 'fal'` + `falModel` route generation to falClient.

export const falV2VModels = [
  {
    id: 'fal-vace-edit',
    name: 'VACE Edit (fal)',
    provider: 'fal',
    falModel: 'fal-ai/wan-vace-14b',
    family: 'vace',
    videoField: 'video_url',
    hasPrompt: true,
    promptRequired: true,
    description: 'Edit your footage with Wan VACE — add, remove, or change elements, restyle, or extend a clip from a text prompt.',
  },
];

export const isFalModel = (model) => !!model && model.provider === 'fal';
