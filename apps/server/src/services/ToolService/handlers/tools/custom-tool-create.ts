import { Tools } from '@snaglet/db/tables/tools';
import { SNAGLET_TOOLS_DIR } from '@server/services/snagletHome';
import type { ToolHandler } from '@server/services/ToolService/types';
import { isRecord } from '@snaglet/shared/utils/type-guards';
import { writeCustomToolScaffold } from './custom-tool-scaffold';

const REGISTRATION_TIMEOUT_MS = 15_000;
const REGISTRATION_POLL_MS = 100;

async function waitForScannerRegistration(folderName: string, toolId: string): Promise<void> {
  const source = `workspace:${folderName}`;
  const deadline = Date.now() + REGISTRATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const row = await Tools.findBySource(source);
    const config = row?.configJson;
    if (
      row?.id === toolId &&
      row.enabled &&
      isRecord(config) &&
      config.workspace_tool === true &&
      typeof config.built_path === 'string'
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, REGISTRATION_POLL_MS));
  }
  throw new Error(
    `Created ${folderName}, but the custom-tool scanner did not register ${toolId} within ${REGISTRATION_TIMEOUT_MS}ms. Check server logs for a TypeScript build error.`
  );
}

const tool: ToolHandler = async (input) => {
  const name = typeof input.name === 'string' ? input.name : '';
  const description = typeof input.description === 'string' ? input.description : '';
  const schema = input.parameters_schema;
  if (schema !== undefined && !isRecord(schema)) {
    throw new Error('parameters_schema must be a JSON object');
  }
  const handlerSource =
    input.handler_source === undefined
      ? undefined
      : typeof input.handler_source === 'string'
        ? input.handler_source
        : (() => {
            throw new Error('handler_source must be a string');
          })();
  if (input.overwrite !== undefined && typeof input.overwrite !== 'boolean') {
    throw new Error('overwrite must be a boolean');
  }

  const created = await writeCustomToolScaffold(SNAGLET_TOOLS_DIR, {
    name,
    description,
    parametersSchema: schema,
    handlerSource,
    overwrite: input.overwrite === true,
  });
  await waitForScannerRegistration(name.trim(), created.toolId);

  return JSON.stringify({
    path: created.folderPath,
    tool_id: created.toolId,
    registered: true,
  });
};

export default tool;
