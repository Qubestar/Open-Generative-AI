async function confirmNarration(dialog, { modelId, voiceId, text }) {
  const { response } = await dialog.showMessageBox({
    type: 'warning', title: 'Approve paid narration',
    message: 'Create one ElevenLabs voiceover?',
    detail: `Model: ${modelId}\nVoice: ${voiceId}\nScript length: ${text.length} characters\n\n${text.slice(0,3000)}${text.length>3000?'\n[Script preview shortened]':''}\n\nThe script leaves this machine. Cost is unknown; this spends separate ElevenLabs API credits, not your coding-agent subscription.`,
    buttons: ['Cancel', 'Approve one voiceover'], defaultId: 0, cancelId: 0, noLink: true,
  });
  if (response !== 1) throw new Error('Paid narration was not approved. No ElevenLabs request was sent.');
}
module.exports = { confirmNarration };
