# Pipeline and agent boundaries

External agents receive public task inputs and Vidmyo capability descriptions. Agent handoffs no longer include private executable paths, pipeline recipes, channel rules or style prompt templates. Director requests allowlist creative fields; Google account tokens and unrelated sheet metadata are excluded. Structured output validation and the existing tool-free provider boundary remain enforced outside the model. MCP errors return fixed actionable categories instead of raw subprocess output.

These changes reduce accidental disclosure and prompt-extraction exposure. They do not make installed code secret from the computer owner, nor prevent a separately launched user agent with filesystem access from reading local files. Model instructions are not access controls. Existing historical handoff files/transcripts are not retroactively erased.

Full proprietary protection requires running private orchestration on a Vidmyo-controlled service with authenticated, authorized capability APIs, server-side secrets, tenant isolation and restricted outputs. This release does not silently move user content to a new service. Local bundled implementation, generated project artifacts and provider-visible generation prompts remain inspectable by their recipients.

Google OAuth credentials and tokens are stored separately in the Electron main process using OS-backed encryption. Public releases still require a registered Google Desktop OAuth client and appropriate consent publication. See [Google setup](google-sheets-connection.md).
