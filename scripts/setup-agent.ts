import { TrueForge, type TrueForgeApi } from '@truefoundry/trueforge-sdk';
import definition from '../config/forge-coder.agent.json';
import { localBaseUrl } from '../src/config';
import { publicError } from '../src/log';

// This checked-in SDK-shaped definition also serves as a model configuration example.
const request: TrueForgeApi.CreateAgentRequest = definition;
try {
  const client = new TrueForge({ baseUrl: localBaseUrl(process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790'),
    token: process.env.TRUEFORGE_TOKEN, maxRetries: 0, timeoutInSeconds: 10 });
  let exists = false;
  for await (const agent of await client.agents.list({ agentName: request.name })) {
    if (agent.name === request.name) { exists = true; break; }
  }
  if (exists) console.log(`Saved agent '${request.name}' already exists; kept its configuration.`);
  else {
    await client.agents.create(request);
    console.log(`Created saved agent '${request.name}'. Configure '${request.manifest.model.name}' in TrueForge Settings → Models before running a turn.`);
  }
} catch (error) { console.error(publicError(error)); process.exitCode = 1; }
