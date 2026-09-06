import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { readHelpSettings } from '../read-aloud/settings';
import { summaryLineOf, toBlockquote } from './note-format';
import {
  PENDING_STALE_GRACE_MS,
  type NotesController,
} from './notes-controller';
import {
  NO_WORKSPACE_FOLDER,
  type DocumentKey,
  type NoteRecord,
} from './notes-store';

/**
 * The Notes view (`featrues/12-notes/spec.md` §13.1): a `TreeDataProvider`
 * over the store's directory tree. With one workspace folder the hierarchy is
 * folders → document → notes; with several, the workspace folders first. Only
 * folders that contain notes exist; unreadable files are listed with a
 * warning and one action.
 */

export const NOTES_VIEW_ID = 'markdown-preview-enhanced.notes';

export type NoteNode =
  | { kind: 'workspace'; folderKey: string; label: string; count: number }
  | {
      kind: 'dir';
      folderKey: string;
      segments: string[];
      label: string;
      count: number;
    }
  | {
      kind: 'document';
      key: DocumentKey;
      dir: string;
      label: string;
      count: number;
      documentUri: vscode.Uri | null;
      title: string;
    }
  | {
      kind: 'note';
      key: DocumentKey;
      record: NoteRecord;
      documentUri: vscode.Uri | null;
    }
  | { kind: 'unreadable'; key: DocumentKey; filePath: string };

interface DirEntry {
  count: number;
  dirs: Map<string, DirEntry>;
  document: { key: DocumentKey; dir: string; count: number } | null;
}

function shortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  try {
    return date.toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
    });
  } catch {
    return iso.slice(0, 10);
  }
}

/** §8.1 — a `pending` older than the timeout plus a minute is stuck. */
export function isStalePending(
  record: NoteRecord,
  now: number = Date.now(),
): boolean {
  if (record.generated.status !== 'pending') {
    return false;
  }
  const since = new Date(record.updated || record.created).getTime();
  if (Number.isNaN(since)) {
    return true;
  }
  const timeoutMs = readHelpSettings().timeoutSeconds * 1000;
  return now - since > timeoutMs + PENDING_STALE_GRACE_MS;
}

export class NotesTreeProvider
  implements vscode.TreeDataProvider<NoteNode>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<
    NoteNode | undefined | void
  >();
  public readonly onDidChangeTreeData = this.emitter.event;
  private readonly controller: NotesController;
  private readonly subscription: vscode.Disposable;
  private readonly parents = new WeakMap<object, NoteNode | undefined>();

  constructor(controller: NotesController) {
    this.controller = controller;
    this.subscription = controller.onDidChange(() => this.refresh());
  }

  public refresh(): void {
    this.emitter.fire();
  }

  public dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }

  // ---------------------------------------------------------- hierarchy

  private folderKeys(): string[] {
    const store = this.controller.notesStore;
    const folders = vscode.workspace.workspaceFolders ?? [];
    const existing = new Set(store.listFolders());
    if (folders.length === 0) {
      return existing.has(NO_WORKSPACE_FOLDER) ? [NO_WORKSPACE_FOLDER] : [];
    }
    const keys: string[] = [];
    for (const folder of folders) {
      const key = this.controller.identityOf(
        vscode.Uri.joinPath(folder.uri, 'x.md'),
      ).key.folder;
      if (existing.has(key)) {
        keys.push(key);
      }
    }
    return keys;
  }

  private treeOf(folderKey: string): DirEntry {
    const root: DirEntry = { count: 0, dirs: new Map(), document: null };
    for (const document of this.controller.notesStore.listDocuments(
      folderKey,
    )) {
      const segments = document.key.document.split('/');
      let cursor = root;
      cursor.count += document.count;
      for (const segment of segments) {
        let next = cursor.dirs.get(segment);
        if (!next) {
          next = { count: 0, dirs: new Map(), document: null };
          cursor.dirs.set(segment, next);
        }
        next.count += document.count;
        cursor = next;
      }
      cursor.document = document;
    }
    return root;
  }

  private childrenOfDir(
    folderKey: string,
    segments: string[],
    entry: DirEntry,
    parent: NoteNode | undefined,
  ): NoteNode[] {
    const out: NoteNode[] = [];
    for (const [name, child] of entry.dirs) {
      const childSegments = [...segments, name];
      let node: NoteNode;
      if (child.document) {
        const newest = this.newestNote(child.document.key);
        node = {
          kind: 'document',
          key: child.document.key,
          dir: child.document.dir,
          label: name,
          count: child.document.count,
          documentUri: this.controller.documentUriFor(
            folderKey,
            child.document.key.document,
            newest?.document.absolute,
          ),
          title: newest?.document.title ?? '',
        };
      } else {
        node = {
          kind: 'dir',
          folderKey,
          segments: childSegments,
          label: name,
          count: child.count,
        };
      }
      this.parents.set(node, parent);
      out.push(node);
    }
    out.sort((a, b) => {
      const da = a.kind === 'dir' ? 0 : 1;
      const db = b.kind === 'dir' ? 0 : 1;
      if (da !== db) {
        return da - db;
      }
      const la = a.kind === 'note' || a.kind === 'unreadable' ? '' : a.label;
      const lb = b.kind === 'note' || b.kind === 'unreadable' ? '' : b.label;
      return la < lb ? -1 : la > lb ? 1 : 0;
    });
    return out;
  }

  private newestNote(key: DocumentKey): NoteRecord | null {
    const listing = this.controller.notesStore.list(key);
    return listing.notes.length
      ? listing.notes[listing.notes.length - 1]
      : null;
  }

  private dirEntryFor(folderKey: string, segments: string[]): DirEntry | null {
    let cursor: DirEntry | undefined = this.treeOf(folderKey);
    for (const segment of segments) {
      cursor = cursor.dirs.get(segment);
      if (!cursor) {
        return null;
      }
    }
    return cursor;
  }

  public getChildren(element?: NoteNode): NoteNode[] {
    if (!element) {
      const keys = this.folderKeys();
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (folders.length > 1) {
        return keys.map((folderKey) => {
          const tree = this.treeOf(folderKey);
          const node: NoteNode = {
            kind: 'workspace',
            folderKey,
            label: folderKey,
            count: tree.count,
          };
          this.parents.set(node, undefined);
          return node;
        });
      }
      const out: NoteNode[] = [];
      for (const folderKey of keys) {
        out.push(
          ...this.childrenOfDir(
            folderKey,
            [],
            this.treeOf(folderKey),
            undefined,
          ),
        );
      }
      return out;
    }
    if (element.kind === 'workspace') {
      return this.childrenOfDir(
        element.folderKey,
        [],
        this.treeOf(element.folderKey),
        element,
      );
    }
    if (element.kind === 'dir') {
      const entry = this.dirEntryFor(element.folderKey, element.segments);
      return entry
        ? this.childrenOfDir(
            element.folderKey,
            element.segments,
            entry,
            element,
          )
        : [];
    }
    if (element.kind === 'document') {
      const listing = this.controller.notesStore.list(element.key);
      const deleting = this.controller.notesStore.deletingIds();
      const out: NoteNode[] = [];
      for (const record of listing.notes) {
        if (deleting.includes(record.id)) {
          continue;
        }
        const node: NoteNode = {
          kind: 'note',
          key: element.key,
          record,
          documentUri: element.documentUri,
        };
        this.parents.set(node, element);
        out.push(node);
      }
      for (const filePath of listing.unreadable) {
        const node: NoteNode = {
          kind: 'unreadable',
          key: element.key,
          filePath,
        };
        this.parents.set(node, element);
        out.push(node);
      }
      return out;
    }
    return [];
  }

  public getParent(element: NoteNode): NoteNode | undefined {
    return this.parents.get(element);
  }

  // ------------------------------------------------------------ tree items

  public getTreeItem(element: NoteNode): vscode.TreeItem {
    switch (element.kind) {
      case 'workspace': {
        const item = new vscode.TreeItem(
          element.label,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.id = `ws:${element.folderKey}`;
        item.description = String(element.count);
        item.iconPath = vscode.ThemeIcon.Folder;
        item.contextValue = 'workspace';
        return item;
      }
      case 'dir': {
        const item = new vscode.TreeItem(
          element.label,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.id = `dir:${element.folderKey}/${element.segments.join('/')}`;
        item.description = String(element.count);
        item.iconPath = vscode.ThemeIcon.Folder;
        item.contextValue = 'dir';
        return item;
      }
      case 'document': {
        const item = new vscode.TreeItem(
          element.label,
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.id = `doc:${element.key.folder}/${element.key.document}`;
        item.description = String(element.count);
        item.tooltip = element.title || element.key.document;
        item.iconPath = vscode.ThemeIcon.File;
        if (element.documentUri) {
          item.resourceUri = element.documentUri;
        }
        item.contextValue = 'document';
        return item;
      }
      case 'note': {
        const record = element.record;
        const item = new vscode.TreeItem(
          record.title || 'Note',
          vscode.TreeItemCollapsibleState.None,
        );
        item.id = `note:${record.id}`;
        const date = shortDate(record.created);
        // D16 — date, then tags, so VS Code's own find widget matches a tag.
        item.description = record.tags.length
          ? `${date} · ${record.tags.join(', ')}`
          : date;
        const stale = isStalePending(record);
        const orphan = !!record.anchor.missingSince;
        if (orphan || stale) {
          item.iconPath = new vscode.ThemeIcon('warning');
        } else if (record.generated.status === 'pending') {
          item.iconPath = new vscode.ThemeIcon('sync');
        } else {
          item.iconPath = new vscode.ThemeIcon('note');
        }
        item.contextValue = orphan
          ? 'note-orphan'
          : record.generated.status === 'pending' && !stale
            ? 'note-pending'
            : 'note';
        const tooltip = new vscode.MarkdownString();
        tooltip.appendMarkdown(toBlockquote(record.passage) + '\n\n');
        const summary = summaryLineOf(record);
        if (summary) {
          tooltip.appendText(summary);
        }
        if (orphan) {
          tooltip.appendMarkdown('\n\n_Not in this version_');
        }
        item.tooltip = tooltip;
        item.command = {
          command: 'markdown-preview-enhanced.notes.revealInPreview',
          title: 'Reveal in preview',
          arguments: [element],
        };
        return item;
      }
      case 'unreadable':
      default: {
        const item = new vscode.TreeItem(
          'Unreadable note file',
          vscode.TreeItemCollapsibleState.None,
        );
        item.id = `bad:${element.filePath}`;
        item.description = path.basename(element.filePath);
        item.iconPath = new vscode.ThemeIcon('warning');
        item.contextValue = 'unreadable';
        item.tooltip = element.filePath;
        item.command = {
          command: 'markdown-preview-enhanced.notes.openNoteFile',
          title: 'Open note file',
          arguments: [element],
        };
        return item;
      }
    }
  }
}

/** `~/.crossnote/notes` rather than the home directory spelled out. */
export function shortenHome(fsPath: string): string {
  const home = os.homedir();
  return fsPath.startsWith(home) ? `~${fsPath.slice(home.length)}` : fsPath;
}
