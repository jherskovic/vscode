/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { coalesce, distinct } from 'vs/base/common/arrays';
import { Schemas } from 'vs/base/common/network';
import { IDisposable, Disposable } from 'vs/base/common/lifecycle';
import { ResourceMap } from 'vs/base/common/map';
import { parse } from 'vs/base/common/marshalling';
import { basename, isEqual } from 'vs/base/common/resources';
import { assertType } from 'vs/base/common/types';
import { URI } from 'vs/base/common/uri';
import { ITextModel, ITextBufferFactory, DefaultEndOfLine, ITextBuffer } from 'vs/editor/common/model';
import { IModelService } from 'vs/editor/common/services/modelService';
import { IModeService } from 'vs/editor/common/services/modeService';
import { ITextModelContentProvider, ITextModelService } from 'vs/editor/common/services/resolverService';
import * as nls from 'vs/nls';
import { Extensions, IConfigurationRegistry } from 'vs/platform/configuration/common/configurationRegistry';
import { IEditorOptions, ITextEditorOptions } from 'vs/platform/editor/common/editor';
import { SyncDescriptor } from 'vs/platform/instantiation/common/descriptors';
import { registerSingleton } from 'vs/platform/instantiation/common/extensions';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { LifecyclePhase } from 'vs/platform/lifecycle/common/lifecycle';
import { Registry } from 'vs/platform/registry/common/platform';
import { EditorDescriptor, Extensions as EditorExtensions, IEditorRegistry } from 'vs/workbench/browser/editor';
import { Extensions as WorkbenchExtensions, IWorkbenchContribution, IWorkbenchContributionsRegistry } from 'vs/workbench/common/contributions';
import { EditorInput, Extensions as EditorInputExtensions, IEditorInput, IEditorInputFactory, IEditorInputFactoryRegistry } from 'vs/workbench/common/editor';
import { IBackupFileService } from 'vs/workbench/services/backup/common/backup';
import { NotebookEditor } from 'vs/workbench/contrib/notebook/browser/notebookEditor';
import { NotebookEditorInput } from 'vs/workbench/contrib/notebook/browser/notebookEditorInput';
import { INotebookService } from 'vs/workbench/contrib/notebook/common/notebookService';
import { NotebookService } from 'vs/workbench/contrib/notebook/browser/notebookServiceImpl';
import { CellKind, CellUri, NotebookDocumentBackupData, NotebookEditorPriority } from 'vs/workbench/contrib/notebook/common/notebookCommon';
import { NotebookProviderInfo } from 'vs/workbench/contrib/notebook/common/notebookProvider';
import { IEditorGroup, OpenEditorContext } from 'vs/workbench/services/editor/common/editorGroupsService';
import { IEditorService, IOpenEditorOverride } from 'vs/workbench/services/editor/common/editorService';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { CustomEditorsAssociations, customEditorsAssociationsSettingId } from 'vs/workbench/services/editor/common/editorAssociationsSetting';
import { CustomEditorInfo } from 'vs/workbench/contrib/customEditor/common/customEditor';
import { NotebookEditorOptions } from 'vs/workbench/contrib/notebook/browser/notebookEditorWidget';
import { INotebookEditor } from 'vs/workbench/contrib/notebook/browser/notebookBrowser';
import { IUndoRedoService } from 'vs/platform/undoRedo/common/undoRedo';
import { NotebookRegistry } from 'vs/workbench/contrib/notebook/browser/notebookRegistry';
import { INotebookEditorModelResolverService, NotebookModelResolverService } from 'vs/workbench/contrib/notebook/common/notebookEditorModelResolverService';

// Editor Contribution

import 'vs/workbench/contrib/notebook/browser/contrib/coreActions';
import 'vs/workbench/contrib/notebook/browser/contrib/find/findController';
import 'vs/workbench/contrib/notebook/browser/contrib/fold/folding';
import 'vs/workbench/contrib/notebook/browser/contrib/format/formatting';
import 'vs/workbench/contrib/notebook/browser/contrib/toc/tocProvider';
import 'vs/workbench/contrib/notebook/browser/contrib/marker/markerProvider';
import 'vs/workbench/contrib/notebook/browser/contrib/status/editorStatus';

// Output renderers registration

import 'vs/workbench/contrib/notebook/browser/view/output/transforms/streamTransform';
import 'vs/workbench/contrib/notebook/browser/view/output/transforms/errorTransform';
import 'vs/workbench/contrib/notebook/browser/view/output/transforms/richTransform';

/*--------------------------------------------------------------------------------------------- */

Registry.as<IEditorRegistry>(EditorExtensions.Editors).registerEditor(
	EditorDescriptor.create(
		NotebookEditor,
		NotebookEditor.ID,
		'Notebook Editor'
	),
	[
		new SyncDescriptor(NotebookEditorInput)
	]
);

class NotebookEditorFactory implements IEditorInputFactory {
	canSerialize(): boolean {
		return true;
	}
	serialize(input: EditorInput): string {
		assertType(input instanceof NotebookEditorInput);
		return JSON.stringify({
			resource: input.resource,
			name: input.name,
			viewType: input.viewType,
			group: input.group
		});
	}
	deserialize(instantiationService: IInstantiationService, raw: string) {
		type Data = { resource: URI, name: string, viewType: string, group: number };
		const data = <Data>parse(raw);
		if (!data) {
			return undefined;
		}
		const { resource, name, viewType } = data;
		if (!data || !URI.isUri(resource) || typeof name !== 'string' || typeof viewType !== 'string') {
			return undefined;
		}

		// if we have two editors open with the same resource (in different editor groups), we should then create two different
		// editor inputs, instead of `getOrCreate`.
		const input = NotebookEditorInput.create(instantiationService, resource, name, viewType);
		if (typeof data.group === 'number') {
			input.updateGroup(data.group);
		}

		return input;
	}

	static async createCustomEditorInput(resource: URI, instantiationService: IInstantiationService): Promise<NotebookEditorInput> {
		return instantiationService.invokeFunction(async accessor => {
			const backupFileService = accessor.get<IBackupFileService>(IBackupFileService);

			const backup = await backupFileService.resolve<NotebookDocumentBackupData>(resource);
			if (!backup?.meta) {
				throw new Error(`No backup found for Notebook editor: ${resource}`);
			}

			const input = NotebookEditorInput.create(instantiationService, resource, backup.meta.name, backup.meta.viewType, { startDirty: true });
			return input;
		});
	}

	static canResolveBackup(editorInput: IEditorInput, backupResource: URI): boolean {
		if (editorInput instanceof NotebookEditorInput) {
			if (isEqual(editorInput.resource.with({ scheme: Schemas.vscodeNotebook }), backupResource)) {
				return true;
			}
		}

		return false;
	}
}

Registry.as<IEditorInputFactoryRegistry>(EditorInputExtensions.EditorInputFactories).registerEditorInputFactory(
	NotebookEditorInput.ID,
	NotebookEditorFactory
);

Registry.as<IEditorInputFactoryRegistry>(EditorInputExtensions.EditorInputFactories).registerCustomEditorInputFactory(
	Schemas.vscodeNotebook,
	NotebookEditorFactory
);

function getFirstNotebookInfo(notebookService: INotebookService, uri: URI): NotebookProviderInfo | undefined {
	return notebookService.getContributedNotebookProviders(uri)[0];
}

export class NotebookContribution extends Disposable implements IWorkbenchContribution {
	private _resourceMapping = new ResourceMap<NotebookEditorInput>();

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@INotebookService private readonly notebookService: INotebookService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IUndoRedoService undoRedoService: IUndoRedoService
	) {
		super();

		this._register(undoRedoService.registerUriComparisonKeyComputer({
			getComparisonKey: (uri: URI): string | null => {
				if (uri.scheme !== CellUri.scheme) {
					return null;
				}

				const data = CellUri.parse(uri);
				if (!data) {
					return null;
				}

				return data.notebook.toString();
			}
		}));

		this._register(this.editorService.overrideOpenEditor({
			getEditorOverrides: (resource: URI, options: IEditorOptions | undefined, group: IEditorGroup | undefined) => {

				const currentEditorForResource = group?.editors.find(editor => isEqual(editor.resource, resource));

				const associatedEditors = distinct([
					...this.getUserAssociatedNotebookEditors(resource),
					...this.getContributedEditors(resource)
				], editor => editor.id);

				return associatedEditors.map(info => {
					return {
						label: info.displayName,
						id: info.id,
						active: currentEditorForResource instanceof NotebookEditorInput && currentEditorForResource.viewType === info.id,
						detail: info.providerDisplayName
					};
				});
			},
			open: (editor, options, group, context, id) => this.onEditorOpening(editor, options, group, context, id)
		}));

		this._register(this.editorService.onDidVisibleEditorsChange(() => {
			const visibleNotebookEditors = editorService.visibleEditorPanes
				.filter(pane => (pane as any).isNotebookEditor)
				.map(pane => pane.getControl() as INotebookEditor)
				.filter(control => !!control)
				.map(editor => editor.getId());

			this.notebookService.updateVisibleNotebookEditor(visibleNotebookEditors);
		}));

		this._register(this.editorService.onDidActiveEditorChange(() => {
			const activeEditorPane = editorService.activeEditorPane as any | undefined;
			const notebookEditor = activeEditorPane?.isNotebookEditor ? activeEditorPane.getControl() : undefined;
			if (notebookEditor) {
				this.notebookService.updateActiveNotebookEditor(notebookEditor);
			} else {
				this.notebookService.updateActiveNotebookEditor(null);
			}
		}));

		this._register(this.editorService.onDidCloseEditor(({ editor }) => {
			if (!(editor instanceof NotebookEditorInput)) {
				return;
			}

			if (!this.editorService.editors.some(other => (
				other.resource === editor.resource
				&& other instanceof NotebookEditorInput
				&& other.viewType === editor.viewType
			))) {
				editor.clearTextModel();
			}

			editor.dispose();
		}));
	}

	getUserAssociatedEditors(resource: URI) {
		const rawAssociations = this.configurationService.getValue<CustomEditorsAssociations>(customEditorsAssociationsSettingId) || [];

		return coalesce(rawAssociations
			.filter(association => CustomEditorInfo.selectorMatches(association, resource)));
	}

	getUserAssociatedNotebookEditors(resource: URI) {
		const rawAssociations = this.configurationService.getValue<CustomEditorsAssociations>(customEditorsAssociationsSettingId) || [];

		return coalesce(rawAssociations
			.filter(association => CustomEditorInfo.selectorMatches(association, resource))
			.map(association => this.notebookService.getContributedNotebookProvider(association.viewType)));
	}

	getContributedEditors(resource: URI) {
		return this.notebookService.getContributedNotebookProviders(resource);
	}

	private onEditorOpening(originalInput: IEditorInput, options: IEditorOptions | ITextEditorOptions | undefined, group: IEditorGroup, context: OpenEditorContext, id: string | undefined): IOpenEditorOverride | undefined {
		if (id === undefined && originalInput.isUntitled()) {
			return;
		}

		if (originalInput instanceof NotebookEditorInput) {
			if ((originalInput.group === group.id || originalInput.group === undefined) && (originalInput.viewType === id || typeof id !== 'string')) {
				// No need to do anything
				originalInput.updateGroup(group.id);
				return {
					override: this.editorService.openEditor(originalInput, new NotebookEditorOptions(options || {}).with({ override: false }), group)
				};
			} else {
				// Create a copy of the input.
				// Unlike normal editor inputs, we do not want to share custom editor inputs
				// between multiple editors / groups.
				const copiedInput = NotebookEditorInput.create(this.instantiationService, originalInput.resource, originalInput.name, originalInput.viewType);
				copiedInput.updateGroup(group.id);

				if (context === OpenEditorContext.MOVE_EDITOR) {
					// transfer ownership of editor widget
					const widgetRef = NotebookRegistry.getNotebookEditorWidget(originalInput);
					if (widgetRef) {
						NotebookRegistry.releaseNotebookEditorWidget(originalInput);
						NotebookRegistry.claimNotebookEditorWidget(copiedInput, widgetRef);
					}
				}

				return {
					override: this.editorService.openEditor(copiedInput, new NotebookEditorOptions(options || {}).with({ override: false }), group)
				};
			}
		}

		let resource = originalInput.resource;
		if (!resource) {
			return undefined;
		}

		if (id === undefined) {
			const existingEditors = group.editors.filter(editor => editor.resource && isEqual(editor.resource, resource) && !(editor instanceof NotebookEditorInput));

			if (existingEditors.length) {
				return undefined;
			}

			const userAssociatedEditors = this.getUserAssociatedEditors(resource);
			const notebookEditor = userAssociatedEditors.filter(association => this.notebookService.getContributedNotebookProvider(association.viewType));

			if (userAssociatedEditors.length && !notebookEditor.length) {
				// user pick a non-notebook editor for this resource
				return undefined;
			}

			// user might pick a notebook editor

			const associatedEditors = distinct([
				...this.getUserAssociatedNotebookEditors(resource),
				...this.getContributedEditors(resource)
			], editor => editor.id).filter(editor => editor.priority === NotebookEditorPriority.default);

			if (!associatedEditors.length) {
				// there is no notebook editor contribution which is enabled by default
				return;
			}

		} else {
			const existingEditors = group.editors.filter(editor => editor.resource && isEqual(editor.resource, resource) && (editor instanceof NotebookEditorInput) && editor.viewType === id);

			if (existingEditors.length) {
				// switch to this cell
				return { override: this.editorService.openEditor(existingEditors[0], new NotebookEditorOptions(options || {}).with({ override: false }), group) };
			}
		}

		let info: NotebookProviderInfo | undefined;
		const data = CellUri.parse(resource);
		if (data) {
			const infos = this.getContributedEditors(data.notebook);

			if (infos.length) {
				const info = id === undefined ? infos[0] : (infos.find(info => info.id === id) || infos[0]);
				// cell-uri -> open (container) notebook
				const name = basename(data.notebook);
				let input = this._resourceMapping.get(data.notebook);
				if (!input || input.isDisposed()) {
					input = NotebookEditorInput.create(this.instantiationService, data.notebook, name, info.id);
					this._resourceMapping.set(data.notebook, input);
				}

				input.updateGroup(group.id);
				return { override: this.editorService.openEditor(input, new NotebookEditorOptions({ ...options, forceReload: true, cellOptions: { resource, options } }), group) };
			}
		}

		const infos = this.notebookService.getContributedNotebookProviders(resource);
		info = id === undefined ? infos[0] : infos.find(info => info.id === id);

		if (!info && id !== undefined) {
			info = this.notebookService.getContributedNotebookProvider(id);
		}

		if (!info) {
			return undefined;
		}

		const input = NotebookEditorInput.create(this.instantiationService, resource, originalInput.getName(), info.id);
		input.updateGroup(group.id);
		this._resourceMapping.set(resource, input);

		/**
		 * Scenario: we are reopening a file editor input which is pinned, we should open in a new editor tab.
		 */
		let index = undefined;
		if (group.activeEditor === originalInput && isEqual(originalInput.resource, resource)) {
			const originalEditorIndex = group.getIndexOfEditor(originalInput);
			index = group.isPinned(originalInput) ? originalEditorIndex + 1 : originalEditorIndex;
		}

		return { override: this.editorService.openEditor(input, new NotebookEditorOptions(options || {}).with({ override: false, index }), group) };
	}
}

class CellContentProvider implements ITextModelContentProvider {

	private readonly _registration: IDisposable;

	constructor(
		@ITextModelService textModelService: ITextModelService,
		@IModelService private readonly _modelService: IModelService,
		@IModeService private readonly _modeService: IModeService,
		@INotebookService private readonly _notebookService: INotebookService,
	) {
		this._registration = textModelService.registerTextModelContentProvider(CellUri.scheme, this);
	}

	dispose(): void {
		this._registration.dispose();
	}

	async provideTextContent(resource: URI): Promise<ITextModel | null> {
		const existing = this._modelService.getModel(resource);
		if (existing) {
			return existing;
		}
		const data = CellUri.parse(resource);
		// const data = parseCellUri(resource);
		if (!data) {
			return null;
		}
		const info = getFirstNotebookInfo(this._notebookService, data.notebook);
		if (!info) {
			return null;
		}

		const editorModel = await this._notebookService.modelManager.resolve(data.notebook, info.id);
		if (!editorModel) {
			return null;
		}

		for (let cell of editorModel.notebook.cells) {
			if (cell.uri.toString() === resource.toString()) {
				const bufferFactory: ITextBufferFactory = {
					create: (defaultEOL) => {
						const newEOL = (defaultEOL === DefaultEndOfLine.CRLF ? '\r\n' : '\n');
						(cell.textBuffer as ITextBuffer).setEOL(newEOL);
						return cell.textBuffer as ITextBuffer;
					},
					getFirstLineText: (limit: number) => {
						return cell.textBuffer.getLineContent(1).substr(0, limit);
					}
				};
				const language = cell.cellKind === CellKind.Markdown ? this._modeService.create('markdown') : (cell.language ? this._modeService.create(cell.language) : this._modeService.createByFilepathOrFirstLine(resource, cell.textBuffer.getLineContent(1)));
				return this._modelService.createModel(
					bufferFactory,
					language,
					resource
				);
			}
		}

		return null;
	}
}

const workbenchContributionsRegistry = Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench);
workbenchContributionsRegistry.registerWorkbenchContribution(NotebookContribution, LifecyclePhase.Starting);
workbenchContributionsRegistry.registerWorkbenchContribution(CellContentProvider, LifecyclePhase.Starting);

registerSingleton(INotebookService, NotebookService);
registerSingleton(INotebookEditorModelResolverService, NotebookModelResolverService, true);

const configurationRegistry = Registry.as<IConfigurationRegistry>(Extensions.Configuration);
configurationRegistry.registerConfiguration({
	id: 'notebook',
	order: 100,
	title: nls.localize('notebookConfigurationTitle', "Notebook"),
	type: 'object',
	properties: {
		'notebook.displayOrder': {
			markdownDescription: nls.localize('notebook.displayOrder.description', "Priority list for output mime types"),
			type: ['array'],
			items: {
				type: 'string'
			},
			default: []
		}
	}
});
