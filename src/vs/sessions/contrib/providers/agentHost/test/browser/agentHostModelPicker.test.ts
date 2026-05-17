/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../../base/common/observable.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { ExtensionIdentifier } from '../../../../../../platform/extensions/common/extensions.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { TestInstantiationService } from '../../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry.js';
import { NullTelemetryService } from '../../../../../../platform/telemetry/common/telemetryUtils.js';
import { ModelPickerActionItem } from '../../../../../../workbench/contrib/chat/browser/widget/input/modelPickerActionItem.js';
import { type ILanguageModelChatMetadataAndIdentifier, ILanguageModelsService } from '../../../../../../workbench/contrib/chat/common/languageModels.js';
import { ISessionsProvidersService } from '../../../../../services/sessions/browser/sessionsProvidersService.js';
import { IActiveSession, ISessionsManagementService } from '../../../../../services/sessions/common/sessionsManagement.js';
import { ISessionsProvider } from '../../../../../services/sessions/common/sessionsProvider.js';
import { SessionStatus } from '../../../../../services/sessions/common/session.js';
import { AgentHostSessionModelPicker, agentHostModelPickerStorageKey, resolveAgentHostModel } from '../../browser/agentHostModelPicker.js';

function makeModel(identifier: string, targetChatSessionType = 'agent-host-copilotcli'): ILanguageModelChatMetadataAndIdentifier {
	return {
		identifier,
		metadata: {
			extension: new ExtensionIdentifier('test.ext'),
			id: identifier,
			name: identifier,
			vendor: 'copilot',
			version: '1.0',
			family: 'copilot',
			maxInputTokens: 128000,
			maxOutputTokens: 4096,
			isDefaultForLocation: {},
			isUserSelectable: true,
			targetChatSessionType,
		},
	};
}

function makeActiveSession(session: Partial<IActiveSession> & { resourceScheme?: string }): IActiveSession {
	const sessionId = session.sessionId ?? 'sess-1';
	const { resourceScheme = 'agent-host-copilotcli', ...sessionProperties } = session;
	return {
		providerId: session.providerId ?? 'default-agent-host',
		sessionId,
		sessionType: session.sessionType ?? 'copilot-cli',
		resource: session.resource ?? URI.from({ scheme: resourceScheme, path: `/${sessionId}` }),
		modelId: session.modelId ?? observableValue<string | undefined>(`modelId-${sessionId}`, undefined),
		status: session.status ?? observableValue<SessionStatus>(`status-${sessionId}`, SessionStatus.Untitled),
		...sessionProperties,
	} as IActiveSession;
}

function stubServices(
	disposables: DisposableStore,
	opts?: {
		models?: ILanguageModelChatMetadataAndIdentifier[];
		activeSession?: Partial<IActiveSession> & { resourceScheme?: string };
		storedEntries?: Map<string, string>;
		setModelSpy?: (sessionId: string, modelId: string) => void;
	},
): { instantiationService: TestInstantiationService; activeSession: ReturnType<typeof observableValue<IActiveSession | undefined>>; fireLanguageModelsChanged: () => void } {
	const instantiationService = disposables.add(new TestInstantiationService());
	const models = opts?.models ?? [];
	const storage = opts?.storedEntries ?? new Map<string, string>();
	const activeSession = opts?.activeSession
		? observableValue<IActiveSession | undefined>('activeSession', makeActiveSession(opts.activeSession))
		: observableValue<IActiveSession | undefined>('activeSession', undefined);
	const onDidChangeLanguageModelsEmitter = disposables.add(new Emitter<string>());

	instantiationService.stubInstance(ModelPickerActionItem, {
		setEnabled: () => { },
		render: () => { },
		dispose: () => { },
	});

	instantiationService.stub(ILanguageModelsService, {
		onDidChangeLanguageModels: onDidChangeLanguageModelsEmitter.event,
		getLanguageModelIds: () => models.map(model => model.identifier),
		lookupLanguageModel: (id: string) => models.find(model => model.identifier === id)?.metadata,
	} as Partial<ILanguageModelsService>);

	instantiationService.stub(IStorageService, {
		get: (key: string, _scope: StorageScope) => storage.get(key),
		store: (key: string, value: string, _scope: StorageScope, _target: StorageTarget) => { storage.set(key, value); },
	} as Partial<IStorageService>);

	instantiationService.stub(ISessionsManagementService, {
		activeSession,
	} as Partial<ISessionsManagementService>);

	const provider: Partial<ISessionsProvider> = {
		id: 'default-agent-host',
		setModel: opts?.setModelSpy ?? (() => { }),
	};
	instantiationService.stub(ISessionsProvidersService, {
		onDidChangeProviders: Event.None,
		getProviders: () => [provider as ISessionsProvider],
	} as Partial<ISessionsProvidersService>);

	instantiationService.stub(IInstantiationService, instantiationService);
	instantiationService.stub(ITelemetryService, NullTelemetryService);

	return { instantiationService, activeSession, fireLanguageModelsChanged: () => onDidChangeLanguageModelsEmitter.fire('test') };
}

suite('AgentHostModelPicker', () => {
	const disposables = new DisposableStore();

	teardown(() => disposables.clear());
	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses resource-scheme-scoped storage keys', () => {
		assert.strictEqual(
			agentHostModelPickerStorageKey('agent-host-copilotcli'),
			'workbench.agentsession.agentHostModelPicker.agent-host-copilotcli.selectedModelId',
		);
		assert.strictEqual(
			agentHostModelPickerStorageKey('remote-localhost__4321-copilotcli'),
			'workbench.agentsession.agentHostModelPicker.remote-localhost__4321-copilotcli.selectedModelId',
		);
	});

	test('uses the current session model from session state', () => {
		const models = [
			makeModel('agent-host-copilotcli:other'),
			makeModel('agent-host-copilotcli:session'),
		];

		assert.strictEqual(
			resolveAgentHostModel(models, 'agent-host-copilotcli:session', 'agent-host-copilotcli:other'),
			models[1],
		);
	});

	test('does not synthesize a model for existing sessions without one in state', () => {
		const models = [
			makeModel('agent-host-copilotcli:first'),
		];

		assert.strictEqual(resolveAgentHostModel(models, undefined, undefined), undefined);
	});

	test('uses the stored model for new untitled sessions with no model yet', () => {
		const models = [
			makeModel('agent-host-copilotcli:first'),
			makeModel('agent-host-copilotcli:stored'),
		];

		assert.strictEqual(resolveAgentHostModel(models, undefined, 'agent-host-copilotcli:stored'), models[1]);
	});

	test('does not fall back to the first model for new untitled sessions without stored state', () => {
		const models = [
			makeModel('agent-host-copilotcli:first'),
		];

		assert.strictEqual(resolveAgentHostModel(models, undefined, undefined), undefined);
	});

	test('propagates selected model to a new untitled session with the same resource scheme', () => {
		const models = [
			makeModel('agent-host-copilotcli:first'),
			makeModel('agent-host-copilotcli:stored'),
		];
		const storedEntries = new Map([[agentHostModelPickerStorageKey('agent-host-copilotcli'), 'agent-host-copilotcli:stored']]);
		const calls: { sessionId: string; modelId: string }[] = [];
		const { instantiationService, activeSession } = stubServices(disposables, {
			models,
			activeSession: { sessionId: 's1' },
			storedEntries,
			setModelSpy: (sessionId, modelId) => calls.push({ sessionId, modelId }),
		});

		disposables.add(instantiationService.createInstance(AgentHostSessionModelPicker));
		activeSession.set(makeActiveSession({ sessionId: 's2' }), undefined);

		assert.deepStrictEqual(calls, [
			{ sessionId: 's1', modelId: 'agent-host-copilotcli:stored' },
			{ sessionId: 's2', modelId: 'agent-host-copilotcli:stored' },
		]);
	});

	test('does not re-push model to the same session when language models change', () => {
		const models = [
			makeModel('agent-host-copilotcli:first'),
			makeModel('agent-host-copilotcli:stored'),
		];
		const storedEntries = new Map([[agentHostModelPickerStorageKey('agent-host-copilotcli'), 'agent-host-copilotcli:stored']]);
		const calls: { sessionId: string; modelId: string }[] = [];
		const { instantiationService, fireLanguageModelsChanged } = stubServices(disposables, {
			models,
			activeSession: { sessionId: 's1' },
			storedEntries,
			setModelSpy: (sessionId, modelId) => calls.push({ sessionId, modelId }),
		});

		disposables.add(instantiationService.createInstance(AgentHostSessionModelPicker));
		fireLanguageModelsChanged();

		assert.deepStrictEqual(calls, [
			{ sessionId: 's1', modelId: 'agent-host-copilotcli:stored' },
		]);
	});

	test('does not push previous current model into existing sessions without model state', () => {
		const models = [
			makeModel('agent-host-copilotcli:first'),
			makeModel('agent-host-copilotcli:stored'),
		];
		const storedEntries = new Map([[agentHostModelPickerStorageKey('agent-host-copilotcli'), 'agent-host-copilotcli:stored']]);
		const calls: { sessionId: string; modelId: string }[] = [];
		const { instantiationService, activeSession } = stubServices(disposables, {
			models,
			activeSession: { sessionId: 'new-session' },
			storedEntries,
			setModelSpy: (sessionId, modelId) => calls.push({ sessionId, modelId }),
		});

		disposables.add(instantiationService.createInstance(AgentHostSessionModelPicker));
		activeSession.set(makeActiveSession({
			sessionId: 'existing-session',
			status: observableValue<SessionStatus>('existingStatus', SessionStatus.Completed),
		}), undefined);

		assert.deepStrictEqual(calls, [
			{ sessionId: 'new-session', modelId: 'agent-host-copilotcli:stored' },
		]);
	});
});
