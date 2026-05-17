/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BaseActionViewItem } from '../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { autorun, observableValue } from '../../../../../base/common/observable.js';
import * as nls from '../../../../../nls.js';
import { IActionViewItemService } from '../../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../../workbench/common/contributions.js';
import { type ILanguageModelChatMetadataAndIdentifier, ILanguageModelsService } from '../../../../../workbench/contrib/chat/common/languageModels.js';
import { type IChatInputPickerOptions } from '../../../../../workbench/contrib/chat/browser/widget/input/chatInputPickerActionItem.js';
import { ModelPickerActionItem, type IModelPickerDelegate } from '../../../../../workbench/contrib/chat/browser/widget/input/modelPickerActionItem.js';
import { ActiveSessionProviderIdContext, IsPhoneLayoutContext } from '../../../../common/contextkeys.js';
import { SessionStatus, type ISession } from '../../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { Menus } from '../../../../browser/menus.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID, REMOTE_AGENT_HOST_PROVIDER_RE } from '../../../../common/agentHostSessionsProvider.js';
import { reportNewChatPickerClosed } from '../../../chat/browser/newChatPickerTelemetry.js';

const IsActiveSessionAgentHost = ContextKeyExpr.or(
	ContextKeyExpr.equals(ActiveSessionProviderIdContext.key, LOCAL_AGENT_HOST_PROVIDER_ID),
	ContextKeyExpr.regex(ActiveSessionProviderIdContext.key, REMOTE_AGENT_HOST_PROVIDER_RE),
);

// -- Agent Host Model Picker Action --

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'sessions.agentHost.modelPicker',
			title: nls.localize2('agentHostModelPicker', "Model"),
			f1: false,
			menu: [{
				id: Menus.NewSessionConfig,
				group: 'navigation',
				order: 1,
				// On phone the {@link MobileChatInputConfigPicker} replaces
				// this picker with a unified mode + model bottom sheet, so
				// gate this desktop-only Action out of phone layouts.
				when: ContextKeyExpr.and(IsActiveSessionAgentHost, IsPhoneLayoutContext.negate()),
			}],
		});
	}
	override async run(): Promise<void> { /* handled by action view item */ }
});

// -- Agent Host Model Picker Contribution --

/**
 * Gets the language models registered for the active agent-host session resource scheme.
 */
export function getAgentHostModels(
	languageModelsService: ILanguageModelsService,
	session: ISession | undefined,
): ILanguageModelChatMetadataAndIdentifier[] {
	if (!session) {
		return [];
	}
	// Filter models by resource scheme. For remote agent hosts the scheme is
	// a unique per-connection ID; for local agent hosts it equals the session
	// type. Both are used as the targetChatSessionType when registering
	// models via AgentHostLanguageModelProvider.
	const resourceScheme = session.resource.scheme;
	return languageModelsService.getLanguageModelIds()
		.map(id => {
			const metadata = languageModelsService.lookupLanguageModel(id);
			return metadata ? { metadata, identifier: id } : undefined;
		})
		.filter((m): m is ILanguageModelChatMetadataAndIdentifier => !!m && m.metadata.targetChatSessionType === resourceScheme);
}

export function agentHostModelPickerStorageKey(resourceScheme: string): string {
	return `workbench.agentsession.agentHostModelPicker.${resourceScheme}.selectedModelId`;
}

/**
 * Resolves the model that should be shown for a session.
 */
export function resolveAgentHostModel(
	models: readonly ILanguageModelChatMetadataAndIdentifier[],
	sessionModelId: string | undefined,
	storedModelId: string | undefined,
): ILanguageModelChatMetadataAndIdentifier | undefined {
	const sessionModel = sessionModelId ? models.find(model => model.identifier === sessionModelId) : undefined;
	if (sessionModel) {
		return sessionModel;
	}

	return storedModelId ? models.find(model => model.identifier === storedModelId) : undefined;
}

export class AgentHostSessionModelPicker extends Disposable {

	private readonly _currentModel = observableValue<ILanguageModelChatMetadataAndIdentifier | undefined>(this, undefined);
	private readonly _delegate: IModelPickerDelegate;
	private readonly _modelPicker: ModelPickerActionItem;
	private _lastResourceScheme: string | undefined;
	private _lastPushedSessionId: string | undefined;
	private _settingModelInternally = false;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@ILanguageModelsService private readonly _languageModelsService: ILanguageModelsService,
		@ISessionsManagementService private readonly _sessionsManagementService: ISessionsManagementService,
		@ISessionsProvidersService private readonly _sessionsProvidersService: ISessionsProvidersService,
		@IStorageService private readonly _storageService: IStorageService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
	) {
		super();

		this._delegate = {
			currentModel: this._currentModel,
			setModel: (model: ILanguageModelChatMetadataAndIdentifier) => {
				const previousModel = this._currentModel.get();
				this._currentModel.set(model, undefined);
				const session = this._sessionsManagementService.activeSession.get();
				if (session) {
					this._storageService.store(agentHostModelPickerStorageKey(session.resource.scheme), model.identifier, StorageScope.PROFILE, StorageTarget.MACHINE);
					const provider = this._sessionsProvidersService.getProviders().find(p => p.id === session.providerId);
					provider?.setModel(session.sessionId, model.identifier);
				}
				if (!this._settingModelInternally) {
					reportNewChatPickerClosed(this._telemetryService, {
						id: 'NewChatAgentHostModelPicker',
						optionIdBefore: previousModel?.identifier,
						optionIdAfter: model.identifier,
						optionLabelBefore: previousModel?.metadata.name,
						optionLabelAfter: model.metadata.name,
						isPII: false,
					});
				}
			},
			getModels: () => getAgentHostModels(this._languageModelsService, this._sessionsManagementService.activeSession.get()),
			useGroupedModelPicker: () => true,
			showManageModelsAction: () => false,
			showUnavailableFeatured: () => false,
			showFeatured: () => true,
		};
		const pickerOptions: IChatInputPickerOptions = {
			hideChevrons: observableValue('hideChevrons', false),
		};
		const action = { id: 'sessions.agentHost.modelPicker', label: '', enabled: true, class: undefined, tooltip: '', run: () => { } };
		this._modelPicker = this._register(instantiationService.createInstance(ModelPickerActionItem, action, this._delegate, pickerOptions));

		this._initModel();
		this._register(this._languageModelsService.onDidChangeLanguageModels(() => this._initModel()));

		this._register(autorun(reader => {
			const session = this._sessionsManagementService.activeSession.read(reader);
			if (session) {
				session.modelId.read(reader);
				session.status.read(reader);
			}
			this._initModel();
		}));
	}

	private _initModel(): void {
		const session = this._sessionsManagementService.activeSession.get();
		const resourceScheme = session?.resource.scheme;

		if (resourceScheme !== this._lastResourceScheme) {
			this._currentModel.set(undefined, undefined);
			this._lastResourceScheme = resourceScheme;
			this._lastPushedSessionId = undefined;
		}

		const models = getAgentHostModels(this._languageModelsService, session);
		this._modelPicker.setEnabled(models.length > 0);

		if (!session || models.length === 0) {
			this._currentModel.set(undefined, undefined);
			return;
		}

		const sessionModelId = session.modelId.get();
		const sessionModel = sessionModelId ? models.find(model => model.identifier === sessionModelId) : undefined;
		const isUntitled = session.status.get() === SessionStatus.Untitled;

		this._settingModelInternally = true;
		try {
			if (!isUntitled) {
				this._currentModel.set(sessionModel, undefined);
				this._lastPushedSessionId = session.sessionId;
				return;
			}

			if (sessionModel) {
				this._currentModel.set(sessionModel, undefined);
				this._lastPushedSessionId = session.sessionId;
				return;
			}

			const current = this._currentModel.get();
			if (current && models.some(model => model.identifier === current.identifier)) {
				if (session.sessionId !== this._lastPushedSessionId) {
					this._delegate.setModel(current);
					this._lastPushedSessionId = session.sessionId;
				}
				return;
			}

			const storedModelId = this._storageService.get(agentHostModelPickerStorageKey(session.resource.scheme), StorageScope.PROFILE);
			const storedModel = resolveAgentHostModel(models, undefined, storedModelId);
			this._currentModel.set(storedModel, undefined);
			if (storedModel && session.sessionId !== this._lastPushedSessionId) {
				this._delegate.setModel(storedModel);
				this._lastPushedSessionId = session.sessionId;
			}
		} finally {
			this._settingModelInternally = false;
		}
	}

	render(container: HTMLElement): void {
		this._modelPicker.render(container);
	}
}

class AgentHostModelPickerContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'sessions.contrib.agentHostModelPicker';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		this._register(actionViewItemService.register(
			Menus.NewSessionConfig, 'sessions.agentHost.modelPicker',
			() => {
				const modelPicker = instantiationService.createInstance(AgentHostSessionModelPicker);
				return new AgentHostPickerActionViewItem(modelPicker);
			},
		));
	}
}

class AgentHostPickerActionViewItem extends BaseActionViewItem {
	constructor(private readonly picker: { render(container: HTMLElement): void; dispose(): void }) {
		super(undefined, { id: '', label: '', enabled: true, class: undefined, tooltip: '', run: () => { } });
	}

	override render(container: HTMLElement): void {
		this.picker.render(container);
	}

	override dispose(): void {
		this.picker.dispose();
		super.dispose();
	}
}

registerWorkbenchContribution2(AgentHostModelPickerContribution.ID, AgentHostModelPickerContribution, WorkbenchPhase.AfterRestored);
