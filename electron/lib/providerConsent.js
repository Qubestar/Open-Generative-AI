// Shared across stateless MCP HTTP requests, which each create a tools server.
let reviewing = false;
async function confirmProviderGeneration(dialog, request) {
  if (reviewing) return false;
  reviewing = true;
  try {
  const settings = Object.fromEntries(Object.entries(request.params).filter(([key])=>key!=='prompt').map(([key,value])=>[key,typeof value==='string'&&value.startsWith('data:')?'[source media will be uploaded]':value]));
  const prompt = String(request.params.prompt || '');
  const {response} = await dialog.showMessageBox({
    type:'warning',title:'Approve one paid AI generation',
    message:`An agent requests one ${request.kind} from ${request.provider}.`,
    detail:`Model: ${request.model}\n\nPrompt: ${prompt.slice(0,6000)}${prompt.length>6000?'\n[Prompt preview shortened]':''}\n\nSettings: ${JSON.stringify(settings).slice(0,3000)}\n\nProvider cost is unknown. This uses separate API credits, not your Codex or Claude subscription. The prompt and any source media leave this machine. Approve only this one request; another generation needs another approval.`,
    buttons:['Cancel','Approve one request'],defaultId:0,cancelId:0,noLink:true,
  });
  return response===1;
  } finally {
    reviewing = false;
  }
}
module.exports={confirmProviderGeneration};
