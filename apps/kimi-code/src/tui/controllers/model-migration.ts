import type { ModelAlias, ThinkingEffort } from '@moonshot-ai/kimi-code-sdk';

import { ChoicePickerComponent } from '../components/dialogs/choice-picker';
import {
  defaultThinkingEffortFor,
  modelDisplayName,
  segmentsFor,
  thinkingAvailability,
} from '../components/dialogs/model-selector';
import {
  currentTuiConfig,
  effectiveModelForHost,
  hasConversationHistory,
  MODEL_SWITCH_CACHE_WARNING,
  performModelSwitch,
} from '../commands/config';
import type { SlashCommandHost } from '../commands/dispatch';
import { saveTuiConfig } from '../config';
import { sanitizeShellOutput } from '../utils/shell-output';

interface ModelMigration {
  readonly fromAlias: string;
  readonly fromModel: string;
  readonly toAlias: string;
  readonly toModel: string;
  readonly displayName: string;
  readonly effort: ThinkingEffort;
  readonly effortHint?: string;
  readonly migrationMarkdown: string;
  readonly retirementAt?: string | null;
}

export interface RetiredDefaultModel {
  readonly from: string;
  readonly to: string;
  /** The dropped model's record, captured before the refresh removed it. */
  readonly fromModel?: ModelAlias;
}

// The live effort is a user choice only when the source model can think at
// all; keep it when the target supports it, else use the target's default.
function migrationEffort(
  host: SlashCommandHost,
  from: ModelAlias | undefined,
  to: ModelAlias,
): ThinkingEffort {
  const targetModel = effectiveModelForHost(host, to);
  const liveEffort = host.state.appState.thinkingEffort;
  return from !== undefined &&
    thinkingAvailability(effectiveModelForHost(host, from)) !== 'unsupported' &&
    segmentsFor(targetModel).includes(liveEffort)
    ? liveEffort
    : defaultThinkingEffortFor(targetModel);
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
  const targetModel = effectiveModelForHost(host, to);
  const effort = migrationEffort(host, from, to);
  const migrationMarkdown = upgrade.migrationMarkdown.trim();
  // Registry-supplied text reaches the terminal verbatim through pi-tui, so
  // strip control sequences the same way captured command output is.
  return {
    fromAlias,
    fromModel: from.model,
    toAlias,
    toModel: to.model,
    displayName: sanitizeShellOutput(modelDisplayName(toAlias, targetModel)),
    effort,
    effortHint:
      thinkingAvailability(targetModel) === 'unsupported' ? undefined : `thinking ${effort}`,
    migrationMarkdown: sanitizeShellOutput(
      migrationMarkdown.length > 0
        ? migrationMarkdown
            .replaceAll('{model_from}', from.model)
            .replaceAll('{model_to}', to.model)
        : `We recommend switching from ${from.model} to ${to.model}.`,
    ),
    retirementAt: upgrade.retirementAt,
  };
}

// A switch needs an idle session and no open dialog (the startup session picker
// may still resume a different session); the prompt also waits for an empty,
// idle editor.
function canSwitchModel(host: SlashCommandHost): boolean {
  return (
    host.state.activeDialog === null &&
    !host.state.editorReplacementMounted &&
    !host.sessionReplacementInFlight &&
    !host.state.appState.isCompacting &&
    !host.state.appState.isReplaying &&
    host.state.appState.streamingPhase === 'idle'
  );
}

function canShowModelMigrationPrompt(host: SlashCommandHost): boolean {
  return (
    canSwitchModel(host) &&
    !host.state.externalEditorRunning &&
    host.state.queuedMessages.length === 0 &&
    !host.state.queuedMessageDispatchPending &&
    host.state.editor.getText().length === 0
  );
}

export class ModelMigrationController {
  private pending = false;
  private scheduled = false;
  private retired: RetiredDefaultModel | undefined;

  constructor(private readonly host: SlashCommandHost & { readonly aborted: boolean }) {}

  request(): void {
    this.pending = true;
    this.retry();
  }

  /** Moves off a default model that a refresh found dropped by its registry. */
  retire(retired: RetiredDefaultModel): void {
    this.retired = retired;
    this.request();
  }

  retry(): void {
    if (!this.pending || this.scheduled) return;
    this.scheduled = true;
    // Defer past editor submission and its lazy-session dispatch continuations.
    queueMicrotask(() => {
      void this.host.waitForLazyCreation()
        .then(() => {
          setImmediate(() => {
            this.scheduled = false;
            if (this.host.aborted || this.host.state.appState.model.length === 0) return;
            // The dropped model cannot serve another turn, so the switch must
            // not wait for an empty editor the way the prompt does.
            const retired = this.retired;
            if (retired !== undefined) {
              if (!canSwitchModel(this.host)) return;
              this.retired = undefined;
              void switchFromRetiredDefault(this.host, retired).catch(() => {
                this.host.showError('Failed to switch from the retired model.');
              });
              return;
            }
            if (!canShowModelMigrationPrompt(this.host)) return;
            this.pending = false;
            void maybeShowModelMigrationPrompt(this.host, () => {
              this.request();
            });
          });
        })
        .catch(() => {
          this.scheduled = false;
          this.host.showError('Failed to check model migration.');
        });
    });
  }
}

export async function maybeShowModelMigrationPrompt(
  host: SlashCommandHost,
  onDisplaced?: () => void,
): Promise<void> {
  const migration = findModelMigration(host);
  if (migration === undefined || !canShowModelMigrationPrompt(host)) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (switchModel: boolean) => {
      if (settled) return;
      settled = true;
      host.restoreEditor();
      void (async () => {
        if (switchModel) {
          if (host.state.appState.availableModels[migration.toAlias] === undefined) {
            resolve();
            return;
          }
          const switched = await performModelSwitch(
            host,
            migration.toAlias,
            migration.effort,
            'model-and-effort',
          );
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

    const notice = migrationNotice(migration);
    host.mountEditorReplacement(
      new ChoicePickerComponent({
        title: 'Model migration available',
        noticeMarkdown: hasConversationHistory(host)
          ? `${notice}\n\n${MODEL_SWITCH_CACHE_WARNING}`
          : notice,
        options: [
          {
            value: 'switch',
            label: `Switch to ${migration.displayName}`,
            description: migration.effortHint,
          },
          { value: 'keep', label: 'Keep current model' },
        ],
        currentValue: 'keep',
        initialValue: 'switch',
        spaceSelect: false,
        onSelect: (value) => finish(value === 'switch'),
        onCancel: () => {
          if (settled) return;
          settled = true;
          host.restoreEditor();
          resolve();
        },
      }),
      () => {
        if (settled) return;
        settled = true;
        onDisplaced?.();
        resolve();
      },
    );
  });
}

async function switchFromRetiredDefault(
  host: SlashCommandHost,
  retired: RetiredDefaultModel,
): Promise<void> {
  const to = host.state.appState.availableModels[retired.to];
  if (to === undefined) return;
  const fromName = sanitizeShellOutput(modelDisplayName(retired.from, retired.fromModel));
  const toName = sanitizeShellOutput(modelDisplayName(retired.to, to));
  host.showStatus(
    `${fromName} is no longer offered by its provider; the default model is now ${toName}.`,
    'warning',
  );
  if (host.state.appState.model !== retired.from) return;
  await performModelSwitch(
    host,
    retired.to,
    migrationEffort(host, retired.fromModel, to),
    'model-and-effort',
  );
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
