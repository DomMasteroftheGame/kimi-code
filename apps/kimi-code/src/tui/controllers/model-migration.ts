import { ChoicePickerComponent } from '../components/dialogs/choice-picker';
import {
  defaultThinkingEffortFor,
  modelDisplayName,
} from '../components/dialogs/model-selector';
import { currentTuiConfig, effectiveModelForHost, performModelSwitch } from '../commands/config';
import type { SlashCommandHost } from '../commands/dispatch';
import { saveTuiConfig } from '../config';

interface ModelMigration {
  readonly fromAlias: string;
  readonly fromModel: string;
  readonly toAlias: string;
  readonly toModel: string;
  readonly displayName: string;
  readonly migrationMarkdown: string;
  readonly retirementAt?: string | null;
}

function findModelMigration(host: SlashCommandHost): ModelMigration | undefined {
  const { model: fromAlias, availableModels, modelMigrations = {} } = host.state.appState;
  const from = availableModels[fromAlias];
  const upgrade = from?.upgrade;
  if (from === undefined || upgrade === undefined || upgrade.model === fromAlias) return;

  const target = Object.entries(availableModels).find(
    ([alias, candidate]) =>
      alias !== fromAlias && candidate.provider === from.provider && alias === upgrade.model,
  );
  if (target === undefined) return;
  const [toAlias, to] = target;
  if (modelMigrations[fromAlias] === to.model) return;
  const migrationMarkdown = upgrade.migrationMarkdown.trim();
  return {
    fromAlias,
    fromModel: from.model,
    toAlias,
    toModel: to.model,
    displayName: modelDisplayName(toAlias, effectiveModelForHost(host, to)),
    migrationMarkdown:
      migrationMarkdown.length > 0
        ? migrationMarkdown
            .replaceAll('{model_from}', from.model)
            .replaceAll('{model_to}', to.model)
        : `We recommend switching from ${from.model} to ${to.model}.`,
    retirementAt: upgrade.retirementAt,
  };
}

export async function maybeShowModelMigrationPrompt(host: SlashCommandHost): Promise<void> {
  const migration = findModelMigration(host);
  if (
    migration === undefined ||
    host.state.activeDialog !== null ||
    host.state.editorReplacementMounted ||
    host.state.appState.streamingPhase !== 'idle'
  ) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (switchModel: boolean) => {
      if (settled) return;
      settled = true;
      host.restoreEditor();
      void (async () => {
        if (switchModel) {
          const target = host.state.appState.availableModels[migration.toAlias];
          if (target === undefined) {
            resolve();
            return;
          }
          const effort = defaultThinkingEffortFor(effectiveModelForHost(host, target));
          const switched = await performModelSwitch(host, migration.toAlias, effort, true);
          if (!switched) {
            resolve();
            return;
          }
        }
        await acknowledgeModelMigration(host, migration);
        resolve();
      })().catch(() => {
        host.showError('Failed to save model migration preference.');
        resolve();
      });
    };

    host.mountEditorReplacement(
      new ChoicePickerComponent({
        title: 'Model migration available',
        notice: migrationNotice(migration),
        options: [
          { value: 'switch', label: `Switch to ${migration.displayName}` },
          { value: 'keep', label: 'Keep current model' },
        ],
        currentValue: 'keep',
        initialValue: 'switch',
        onSelect: (value) => finish(value === 'switch'),
        onCancel: () => {
          if (settled) return;
          settled = true;
          host.restoreEditor();
          resolve();
        },
      }),
    );
  });
}

function migrationNotice(migration: ModelMigration): string {
  const retirementAt = migration.retirementAt;
  if (retirementAt === undefined || retirementAt === null) return migration.migrationMarkdown;
  const timestamp = Date.parse(retirementAt);
  if (!Number.isFinite(timestamp)) return migration.migrationMarkdown;
  return `${migration.migrationMarkdown}\n\nRetirement date: ${new Date(timestamp).toLocaleDateString()}`;
}

async function acknowledgeModelMigration(
  host: SlashCommandHost,
  migration: ModelMigration,
): Promise<void> {
  const modelMigrations = {
    ...host.state.appState.modelMigrations,
    [migration.fromAlias]: migration.toModel,
  };
  host.setAppState({ modelMigrations });
  await saveTuiConfig({
    ...currentTuiConfig(host),
    notice: { modelMigrations },
  });
}
