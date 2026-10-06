const { Plugin, Modal, Notice, ItemView, MarkdownView, moment, setIcon, Setting, PluginSettingTab, requestUrl } = require('obsidian');

const VIEW_TYPE = 'continuum-sidebar-view';
const CONTINUUM_PLUGIN_VERSION = '1.0.1';
const CONTINUUM_DATA_SCHEMA_VERSION = 8;

const CONTINUUM_UPDATE_FILE_PREFIX = 'https://raw.githubusercontent.com/sergiykryvoruchko1991-commits/Continuum-English-/';
const CONTINUUM_UPDATE_ALLOWED_FILES = ['main.js', 'styles.css', 'manifest.json'];
const CONTINUUM_SHARED_SESSION_SECRET_ID = 'continuum-shared-session-v1';
const CONTINUUM_SYNC_GRACE_MS = 30000;
const CONTINUUM_UPDATE_PUBLIC_KEY_SPKI = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEuIQSjJp6t3+aHa6s+OGpGElfvKpWuyISIF0hJyTLp5/w1qxB653i/eZNsyJD04BlF7HiyvmP5a09Vpu4sjOmHw==';

const CONTINUUM_INITIAL_FOLDERS = [
  '00 Inbox', '01 Days', '02 Knowledge', '03 Journals',
  '04 Templates', '05 Archive', 'Attachments'
];

const CONTINUUM_INITIAL_FILES = {
  'Home.md': `# Welcome to CONTINUUM

CONTINUUM helps you keep thoughts, events, ideas and useful information in one clear space. Everything starts with a daily entry and stays linked to that specific day.

## Where to start

1. Tap **"Open today"**.
2. Make your first entry.
3. Create a personal section.
4. Choose where the entry should go.

> [!continuum]- Personal
> Daily entries, events, thoughts and ideas. An entry is saved together with its date and topic, and tapping it takes you back to the full context of that day.

> [!continuum]- Together
> A protected space for two people: separate initial positions, joint discussion and a shared calendar. Connected by an administrator and requires internet.

> [!continuum]- Projects & knowledge
> Personal projects, calculations, measurements, work materials, books, videos and other information you need to come back to.

> [!continuum]- Motivation
> Thoughts, rules and reminders about what is really important to you.

> [!continuum]- Archive
> Finished or temporarily irrelevant sections. Information is not deleted and stays available.

> [!continuum]- Data and backups
> Personal notes are stored on your device by default. Moving them between devices depends on the sync method you choose. "Together" uses a separate network storage belonging to the owner.
>
> A backup made before an update contains only CONTINUUM system files — personal notes and attachments are not included. Make a separate backup of your whole vault.

> [!continuum]- Customization
> Names, appearance, starter sections and features can be adapted to a specific user. Special changes are made through the administrator.
`,
  'FIRST LAUNCH.md': `# First launch of CONTINUUM

1. Open the CONTINUUM sidebar.
2. Tap **"Open today"** and make your first entry.
3. Create a personal section and choose it when adding a block to a day.
4. Open the section you created to see the date, the topic and the link back to the original day.

## Data

Personal notes are stored on your device by default. You connect syncing between devices separately. It does not replace a backup.

The "Together" section is connected by an administrator, requires internet and uses a separate network storage belonging to the owner.

Before an update, CONTINUUM can save a copy of the system files only. Notes, journals and attachments are not included in that copy.
`,
  'CONTINUUM Rules.md': `# CONTINUUM rules

## Together

- Each participant publishes their initial position independently.
- Your partner's position opens only after both positions have been published.
- Initial positions cannot be changed after publishing.
- You can edit your own later comments; they get an "Edited" mark and the previous versions stay available.
- Closing a topic requires the consent of both participants.
- A closed topic stays read-only.
`,
  '04 Templates/Day template.md': `## Hello 👋 What will you share today? 🤔

`,
  '00 Inbox/README.md': '# Inbox\n\nA temporary place for material that still needs sorting.\n',
  '05 Archive/README.md': '# Archive\n\nFinished and temporarily irrelevant CONTINUUM sections.\n'
};

function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const av = pa[i] || 0;
    const bv = pb[i] || 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

function sanitizeUpdateChannel(value) {
  const channel = String(value || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(channel) ? channel : '';
}

function formatJournalDate(date) {
  const value = moment(date, 'YYYY-MM-DD', true);
  return value.isValid() ? value.format('DD.MM.YYYY') : String(date || '');
}

async function sha256Text(text) {
  if (!window.crypto?.subtle) throw new Error("SHA-256 verification is not available on this device");
  const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function verifyUpdateManifestSignature(manifest) {
  if (manifest.signatureAlgorithm !== 'ECDSA_P256_SHA256' || typeof manifest.signature !== 'string') return false;
  if (!window.crypto?.subtle) throw new Error("Digital signature verification is not available on this device");
  const payload = { ...manifest };
  delete payload.signature;
  const key = await window.crypto.subtle.importKey(
    'spki',
    base64ToBytes(CONTINUUM_UPDATE_PUBLIC_KEY_SPKI),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );
  return window.crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    base64ToBytes(manifest.signature),
    new TextEncoder().encode(canonicalJson(payload))
  );
}

// A commercial copy starts without the author's personal categories. Only the
// universal Idea journal is present so ideas can be captured from a daily note.
const BUILTIN_TYPES = [
  { key: 'idea', label: '💡 Idea', journal: 'Ideas' },
  { key: 'note', label: '📝 Plain note', journal: null }
];

const BUILTIN_JOURNALS = [['💡', 'Ideas']];

class ChoiceModal extends Modal {
  constructor(app, plugin, onChoose) {
    super(app);
    this.plugin = plugin;
    this.onChoose = onChoose;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('continuum-choice-modal');
    contentEl.createEl('h2', { text: "Add a block to the day" });
    const grid = contentEl.createDiv({ cls: 'continuum-grid' });
    this.plugin.getAllTypes().forEach(type => {
      const button = grid.createEl('button', { text: type.label, cls: 'continuum-choice' });
      button.onclick = () => {
        this.close();
        this.onChoose(type);
      };
    });
  }

  onClose() { this.contentEl.empty(); }
}

class AddSectionModal extends Modal {
  constructor(app, plugin, preferredType = 'journal') {
    super(app);
    this.plugin = plugin;
    this.name = '';
    this.emoji = '📌';
    this.sectionType = preferredType === 'library' ? 'library' : 'journal';
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('continuum-section-modal', 'continuum-add-section-modal');
    contentEl.createEl('h2', { text: "New section" });

    // 1. Name: first field, so it stays above the keyboard on iPhone.
    const nameSetting = new Setting(contentEl)
      .setName("Section name")
      .setDesc("For example: Health or Home renovation")
      .addText(text => {
        text.setPlaceholder("Name");
        text.inputEl.addClass('continuum-section-name-input');
        text.onChange(value => { this.name = value.trim(); });

        const keepVisible = () => {
          const item = text.inputEl.closest('.setting-item') || text.inputEl;
          [80, 220, 450].forEach(delay => window.setTimeout(() => {
            try { item.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'auto' }); } catch (_) {}
          }, delay));
        };
        text.inputEl.addEventListener('focus', keepVisible);
        text.inputEl.addEventListener('click', keepVisible);
      });
    nameSetting.settingEl.addClass('continuum-section-name-setting');

    // 2. Icon.
    new Setting(contentEl)
      .setName("Icon")
      .setDesc("Any emoji")
      .addText(text => text
        .setPlaceholder('📌')
        .setValue(this.emoji)
        .onChange(value => { this.emoji = value.trim() || '📌'; }));

    // 3. Section type. Short labels without extra text.
    new Setting(contentEl)
      .setName("Section type")
      .setDesc("Personal — for day-by-day entries · Projects & knowledge — for folders and files")
      .addDropdown(dropdown => dropdown
        .addOption('journal', "📝 Personal section")
        .addOption('library', "📚 Project or knowledge")
        .setValue(this.sectionType)
        .onChange(value => { this.sectionType = value; }));

    const actions = contentEl.createDiv({ cls: 'continuum-section-actions' });
    const cancel = actions.createEl('button', { text: "Cancel" });
    cancel.onclick = () => this.close();
    const create = actions.createEl('button', { text: "Create", cls: 'mod-cta' });
    create.onclick = async () => {
      if (!this.name) {
        new Notice("Enter a section name");
        return;
      }
      const ok = await this.plugin.addCustomSection(this.name, this.emoji, this.sectionType);
      if (ok) this.close();
    };
  }

  onClose() { this.contentEl.empty(); }
}

class NewDocumentModal extends Modal {
  constructor(app, plugin, folderPath, onCreated) {
    super(app);
    this.plugin = plugin;
    this.folderPath = folderPath;
    this.onCreated = onCreated;
    this.name = '';
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: "New note" });
    new Setting(contentEl)
      .setName("Name")
      .setDesc("The note will be created in the current \"Projects & knowledge\" section.")
      .addText(text => {
        text.setPlaceholder("Note name");
        text.onChange(value => { this.name = value.trim(); });
        setTimeout(() => text.inputEl.focus(), 50);
      });

    const actions = contentEl.createDiv({ cls: 'continuum-section-actions' });
    actions.createEl('button', { text: "Cancel" }).onclick = () => this.close();
    const create = actions.createEl('button', { text: "Create note", cls: 'mod-cta' });
    create.onclick = async () => {
      if (!this.name) return new Notice("Enter a note name");
      const file = await this.plugin.createLibraryDocument(this.folderPath, this.name);
      if (file) {
        this.close();
        if (this.onCreated) this.onCreated(file);
      }
    };
  }

  onClose() { this.contentEl.empty(); }
}

class NewLibraryFolderModal extends Modal {
  constructor(app, plugin, parentPath, onCreated) {
    super(app);
    this.plugin = plugin;
    this.parentPath = parentPath;
    this.onCreated = onCreated;
    this.name = '';
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: "New folder" });
    new Setting(contentEl)
      .setName("Name")
      .setDesc("You can create other folders and notes inside it.")
      .addText(text => {
        text.setPlaceholder("For example: Main engine");
        text.onChange(value => { this.name = value.trim(); });
        setTimeout(() => text.inputEl.focus(), 50);
      });

    const actions = contentEl.createDiv({ cls: 'continuum-section-actions' });
    actions.createEl('button', { text: "Cancel" }).onclick = () => this.close();
    const create = actions.createEl('button', { text: "Create folder", cls: 'mod-cta' });
    create.onclick = async () => {
      if (!this.name) return new Notice("Enter a folder name");
      const folder = await this.plugin.createLibraryFolder(this.parentPath, this.name);
      if (folder) {
        this.close();
        if (this.onCreated) this.onCreated(folder);
      }
    };
  }

  onClose() { this.contentEl.empty(); }
}

class LibraryModal extends Modal {
  constructor(app, plugin, rootPath, emoji, label, currentPath = null) {
    super(app);
    this.plugin = plugin;
    this.rootPath = rootPath;
    this.currentPath = currentPath || rootPath;
    this.emoji = emoji;
    this.label = label;
  }

  onOpen() { this.render(); }

  getRelativeParts() {
    if (this.currentPath === this.rootPath) return [];
    return this.currentPath.slice(this.rootPath.length).replace(/^\//, '').split('/').filter(Boolean);
  }

  openFolder(path) {
    this.currentPath = path;
    this.render();
  }

  renderBreadcrumbs(container) {
    const crumbs = container.createDiv({ cls: 'continuum-library-breadcrumbs' });
    const root = crumbs.createEl('button', { text: this.label, cls: 'continuum-library-crumb' });
    root.onclick = () => this.openFolder(this.rootPath);
    let path = this.rootPath;
    for (const part of this.getRelativeParts()) {
      crumbs.createSpan({ text: '›', cls: 'continuum-library-crumb-separator' });
      path = `${path}/${part}`;
      const target = path;
      const crumb = crumbs.createEl('button', { text: part, cls: 'continuum-library-crumb' });
      crumb.onclick = () => this.openFolder(target);
    }
  }

  render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('continuum-library-modal');

    const header = contentEl.createDiv({ cls: 'continuum-library-header continuum-library-browser-header' });
    const titleWrap = header.createDiv({ cls: 'continuum-library-title-wrap' });
    titleWrap.createEl('h2', { text: `${this.emoji} ${this.currentPath === this.rootPath ? this.label : this.currentPath.split('/').pop()}` });
    if (this.currentPath !== this.rootPath) {
      const up = header.createEl('button', { text: "← Back", cls: 'continuum-library-back' });
      up.onclick = () => {
        const parent = this.currentPath.split('/').slice(0, -1).join('/');
        this.openFolder(parent.startsWith(this.rootPath) ? parent : this.rootPath);
      };
    }

    this.renderBreadcrumbs(contentEl);

    const createBar = contentEl.createDiv({ cls: 'continuum-library-create-bar' });
    const addFolder = createBar.createEl('button', { text: "＋ Folder", cls: 'mod-cta' });
    addFolder.onclick = () => new NewLibraryFolderModal(this.app, this.plugin, this.currentPath, () => this.render()).open();
    const addFile = createBar.createEl('button', { text: "＋ Note" });
    addFile.onclick = () => {
      new NewDocumentModal(this.app, this.plugin, this.currentPath, async file => {
        await this.app.workspace.getLeaf(false).openFile(file);
      }).open();
    };

    const folder = this.app.vault.getAbstractFileByPath(this.currentPath);
    const children = folder && Array.isArray(folder.children) ? [...folder.children] : [];
    const folders = children
      .filter(item => Array.isArray(item.children))
      .sort((a, b) => a.name.localeCompare(b.name, 'en'));
    const files = children
      .filter(item => item.extension === 'md' && !/^README$/i.test(item.basename))
      .sort((a, b) => a.basename.localeCompare(b.basename, 'en'));

    if (!folders.length && !files.length) {
      contentEl.createEl('p', {
        text: "The folder is empty. Create a subfolder or a note.",
        cls: 'setting-item-description continuum-library-empty'
      });
      return;
    }

    const list = contentEl.createDiv({ cls: 'continuum-library-list continuum-library-tree-list' });
    folders.forEach(folderItem => {
      const button = list.createEl('button', { cls: 'continuum-library-entry continuum-library-folder' });
      button.createSpan({ text: '📁', cls: 'continuum-library-entry-icon' });
      button.createSpan({ text: folderItem.name, cls: 'continuum-library-entry-name' });
      button.createSpan({ text: '›', cls: 'continuum-library-entry-chevron' });
      button.onclick = () => this.openFolder(folderItem.path);
    });
    files.forEach(file => {
      const button = list.createEl('button', { cls: 'continuum-library-entry continuum-library-note' });
      button.createSpan({ text: '📄', cls: 'continuum-library-entry-icon' });
      button.createSpan({ text: file.basename, cls: 'continuum-library-entry-name' });
      button.onclick = async () => {
        this.close();
        await this.app.workspace.getLeaf(false).openFile(file);
      };
    });
  }

  onClose() { this.contentEl.empty(); }
}


class SectionActionsModal extends Modal {
  constructor(app, plugin, section) {
    super(app);
    this.plugin = plugin;
    this.section = section;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('continuum-section-actions-modal');
    contentEl.createEl('h2', { text: `${this.section.emoji} ${this.section.name}` });
    contentEl.createEl('p', {
      text: this.section.type === 'journal'
        ? "Archiving removes the section from the active menu and from the list of new blocks. Entries in daily notes stay in place, and the list of links is kept in the Archive."
        : "Archiving removes the section from the active menu and moves its folder with all files to the Archive.",
      cls: 'setting-item-description'
    });

    const archive = contentEl.createEl('button', { text: "📦 Move to archive", cls: 'continuum-danger-action' });
    archive.onclick = async () => {
      const ok = await this.plugin.archiveSection(this.section);
      if (ok) this.close();
    };

    const cancel = contentEl.createEl('button', { text: "Cancel", cls: 'continuum-secondary-action' });
    cancel.onclick = () => this.close();
  }

  onClose() { this.contentEl.empty(); }
}

class ArchiveItemModal extends Modal {
  constructor(app, plugin, item, onDone) {
    super(app);
    this.plugin = plugin;
    this.item = item;
    this.onDone = onDone;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: `${this.item.emoji} ${this.item.name}` });
    contentEl.createEl('p', {
      text: this.item.type === 'journal'
        ? "Entries already added to daily notes are kept regardless of what you do with this section."
        : "This section's files are currently in the Archive.",
      cls: 'setting-item-description'
    });

    const actions = contentEl.createDiv({ cls: 'continuum-archive-item-actions' });
    const restore = actions.createEl('button', { text: "↩️ Restore", cls: 'mod-cta' });
    restore.onclick = async () => {
      const ok = await this.plugin.restoreArchivedSection(this.item);
      if (ok) {
        this.close();
        if (this.onDone) this.onDone();
      }
    };

    const remove = actions.createEl('button', { text: "🗑 Delete permanently", cls: 'continuum-danger-action' });
    remove.onclick = async () => {
      const confirmed = window.confirm(
        this.item.type === 'journal'
          ? "Permanently delete this section from the Archive? Daily notes and the text inside them will be kept."
          : "Permanently delete this section and all its files? This cannot be undone."
      );
      if (!confirmed) return;
      const ok = await this.plugin.deleteArchivedSection(this.item);
      if (ok) {
        this.close();
        if (this.onDone) this.onDone();
      }
    };
  }

  onClose() { this.contentEl.empty(); }
}

class ArchiveModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() { this.render(); }

  render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('continuum-archive-modal');
    contentEl.createEl('h2', { text: "📦 Archive" });
    contentEl.createEl('p', {
      text: "Archived sections are kept here. You can restore them or delete them permanently; entries in daily notes are not deleted.",
      cls: 'setting-item-description'
    });

    if (!this.plugin.archivedSections.length) {
      contentEl.createEl('p', { text: "The archive is empty." });
      return;
    }

    const groups = [
      ['journal', "📝 Personal"],
      ['library', "📚 Projects & knowledge"]
    ];
    groups.forEach(([type, title]) => {
      const items = this.plugin.archivedSections.filter(item => item.type === type);
      if (!items.length) return;
      contentEl.createEl('h3', { text: title });
      const list = contentEl.createDiv({ cls: 'continuum-archive-list' });
      items.forEach(item => {
        const button = list.createEl('button', { cls: 'continuum-archive-row' });
        button.createSpan({ text: item.emoji || '📌' });
        const text = button.createSpan();
        text.createEl('strong', { text: item.name });
        if (item.archivedAt) text.createEl('small', { text: `Archived: ${moment(item.archivedAt).format('D MMM YYYY')}` });
        button.onclick = () => new ArchiveItemModal(this.app, this.plugin, item, () => this.render()).open();
      });
    });
  }

  onClose() { this.contentEl.empty(); }
}




function blurActiveEditable() {
  const el = document.activeElement;
  if (!el) return;
  const tag = (el.tagName || '').toLowerCase();
  const editable = tag === 'input' || tag === 'textarea' || el.isContentEditable;
  if (editable && typeof el.blur === 'function') el.blur();
}

function attachMobileKeyboardDismiss(rootEl) {
  if (!rootEl) return () => {};
  if (typeof rootEl.__continuumKeyboardCleanup === 'function') {
    rootEl.__continuumKeyboardCleanup();
  }

  const isEditable = (target) => {
    if (!(target instanceof Element)) return false;
    return !!target.closest('input, textarea, [contenteditable="true"]');
  };

  // Important on iOS: do not blur on pointerdown/touchstart or scroll.
  // Those events may fire while the system keyboard is opening and can
  // immediately cancel focus, making the keyboard appear to "twitch".
  const dismissOutside = (event) => {
    if (!isEditable(event.target)) blurActiveEditable();
  };

  rootEl.addEventListener('click', dismissOutside, false);

  const cleanup = () => {
    rootEl.removeEventListener('click', dismissOutside, false);
    if (rootEl.__continuumKeyboardCleanup === cleanup) rootEl.__continuumKeyboardCleanup = null;
  };
  rootEl.__continuumKeyboardCleanup = cleanup;
  return cleanup;
}

function attachMobileKeyboardAvoidance(rootEl) {
  if (!rootEl) return () => {};
  if (typeof rootEl.__continuumKeyboardAvoidCleanup === 'function') rootEl.__continuumKeyboardAvoidCleanup();

  const viewport = window.visualViewport;
  const modal = rootEl.closest?.('.modal') || null;
  const modalContainer = rootEl.closest?.('.modal-container') || null;
  let focusTimers = [];

  const clearFocusTimers = () => {
    focusTimers.forEach(id => window.clearTimeout(id));
    focusTimers = [];
  };

  const keepVisible = (element) => {
    if (!(element instanceof Element) || !rootEl.contains(element)) return;
    if (!element.matches('input, textarea, [contenteditable="true"]')) return;
    const scrollHost = rootEl.closest?.('.modal-content') || rootEl;
    clearFocusTimers();
    [40, 140, 300, 520, 800].forEach(delay => {
      focusTimers.push(window.setTimeout(() => {
        try {
          const vv = window.visualViewport;
          const visibleTop = (vv ? vv.offsetTop : 0) + 76;
          const visibleBottom = (vv ? vv.offsetTop + vv.height : window.innerHeight) - 36;
          const rect = element.getBoundingClientRect();
          if (rect.bottom > visibleBottom) scrollHost.scrollTop += rect.bottom - visibleBottom + 44;
          if (rect.top < visibleTop) scrollHost.scrollTop -= visibleTop - rect.top + 24;
          element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
          if (rootEl.classList.contains('continuum-add-section-modal')) {
            const item = element.closest('.setting-item') || element;
            item.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'auto' });
            scrollHost.scrollTop = Math.max(0, scrollHost.scrollTop - 18);
          }
        } catch (_) {}
      }, delay));
    });
  };

  const update = () => {
    const vvHeight = viewport ? viewport.height : window.innerHeight;
    const vvTop = viewport ? viewport.offsetTop : 0;
    const keyboardOpen = viewport ? vvHeight < window.innerHeight * 0.82 : false;

    const keyboardHeight = viewport ? Math.max(0, window.innerHeight - (viewport.height + viewport.offsetTop)) : 0;
    rootEl.style.setProperty('--continuum-vv-height', `${Math.max(240, Math.round(vvHeight))}px`);
    rootEl.style.setProperty('--continuum-keyboard-offset', keyboardOpen ? `${Math.max(24, Math.round(keyboardHeight))}px` : '0px');
    rootEl.classList.toggle('is-keyboard-open', keyboardOpen);

    if (modal) {
      modal.classList.add('continuum-keyboard-safe-modal');
      modal.style.maxHeight = `${Math.max(220, Math.round(vvHeight - 16))}px`;
    }
    if (modalContainer) {
      modalContainer.classList.add('continuum-keyboard-safe-container');
      modalContainer.style.height = `${Math.max(240, Math.round(vvHeight))}px`;
      modalContainer.style.top = `${Math.max(0, Math.round(vvTop))}px`;
      modalContainer.style.bottom = 'auto';
      modalContainer.style.alignItems = 'flex-start';
      modalContainer.style.paddingTop = '8px';
      modalContainer.style.boxSizing = 'border-box';
    }

    if (keyboardOpen) keepVisible(document.activeElement);
  };

  const onFocus = event => {
    const target = event.target;
    if (target instanceof Element && target.matches('input, textarea, [contenteditable="true"]')) {
      update();
      keepVisible(target);
    }
  };

  rootEl.addEventListener('focusin', onFocus, true);
  if (viewport) {
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
  }
  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', update);
  update();

  const cleanup = () => {
    clearFocusTimers();
    rootEl.removeEventListener('focusin', onFocus, true);
    if (viewport) {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    }
    window.removeEventListener('resize', update);
    window.removeEventListener('orientationchange', update);
    rootEl.style.removeProperty('--continuum-vv-height');
    rootEl.style.removeProperty('--continuum-keyboard-offset');
    rootEl.classList.remove('is-keyboard-open');
    if (modal) {
      modal.classList.remove('continuum-keyboard-safe-modal');
      modal.style.removeProperty('max-height');
    }
    if (modalContainer) {
      modalContainer.classList.remove('continuum-keyboard-safe-container');
      for (const prop of ['height','top','bottom','align-items','padding-top','box-sizing']) modalContainer.style.removeProperty(prop);
    }
    if (rootEl.__continuumKeyboardAvoidCleanup === cleanup) rootEl.__continuumKeyboardAvoidCleanup = null;
  };
  rootEl.__continuumKeyboardAvoidCleanup = cleanup;
  return cleanup;
}

function attachSpeechDictation(button, textarea, locale = 'en-US') {
  if (!button || !textarea) return () => {};
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let running = false;
  let destroyed = false;

  const setIdle = () => {
    running = false;
    button.removeClass('is-listening');
    button.setText("🎙️ Dictate");
  };

  const insertTranscript = text => {
    const transcript = String(text || '').trim();
    if (!transcript) return;
    const start = Number.isInteger(textarea.selectionStart) ? textarea.selectionStart : textarea.value.length;
    const end = Number.isInteger(textarea.selectionEnd) ? textarea.selectionEnd : start;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    const space = before && !/\s$/.test(before) ? ' ' : '';
    textarea.value = `${before}${space}${transcript}${after}`;
    const caret = (before + space + transcript).length;
    try { textarea.setSelectionRange(caret, caret); } catch (_) {}
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();
  };

  button.onclick = () => {
    if (!Recognition) {
      textarea.focus();
      new Notice("Separate speech recognition is not available on this device. The input field is open — use the microphone on your system keyboard to dictate.");
      return;
    }
    if (running && recognition) {
      try { recognition.stop(); } catch (_) {}
      return;
    }
    recognition = new Recognition();
    recognition.lang = locale;
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => {
      running = true;
      button.addClass('is-listening');
      button.setText("⏹ Stop");
    };
    recognition.onresult = event => {
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        if (event.results[i].isFinal) insertTranscript(event.results[i][0]?.transcript || '');
      }
    };
    recognition.onerror = event => {
      const code = event?.error || 'unknown';
      if (code !== 'aborted' && code !== 'no-speech') new Notice(`Dictation: ${code}`);
      setIdle();
    };
    recognition.onend = () => { if (!destroyed) setIdle(); };
    try { recognition.start(); }
    catch (e) {
      setIdle();
      new Notice(`Could not start dictation: ${e.message || e}`);
    }
  };

  return () => {
    destroyed = true;
    if (recognition) { try { recognition.abort(); } catch (_) {} }
    setIdle();
  };
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

class RelationshipSessionModal extends Modal {
  constructor(app, plugin, onReady) {
    super(app);
    this.plugin = plugin;
    this.onReady = onReady;
    this.password = '';
    this.encryptionSecret = '';
    this.cleanupKeyboardDismiss = null;
    this.cleanupKeyboardAvoidance = null;
    this.cleanupDictation = null;
  }

  onOpen() {
    const { contentEl } = this;
    this.cleanupKeyboardDismiss = attachMobileKeyboardDismiss(contentEl);
    this.cleanupKeyboardAvoidance = attachMobileKeyboardAvoidance(contentEl);
    contentEl.addClass('continuum-relationship-login');
    contentEl.createEl('h2', { text: "❤️ Together" });
    new Setting(contentEl)
      .setName("User password")
      .addText(text => {
        text.inputEl.type = 'password';
        text.setPlaceholder("Shared space password");
        text.onChange(value => { this.password = value; });
      });

    new Setting(contentEl)
      .setName("Encryption key")
      .addText(text => {
        text.inputEl.type = 'password';
        text.setPlaceholder('Encryption key');
        text.onChange(value => { this.encryptionSecret = value; });
      });

    const actions = contentEl.createDiv({ cls: 'continuum-section-actions' });
    const cancel = actions.createEl('button', { text: "Cancel" });
    cancel.onclick = () => this.close();
    const login = actions.createEl('button', { text: "Sign in", cls: 'mod-cta' });
    login.onclick = async () => {
      if (!this.password || this.encryptionSecret.length < 16) {
        new Notice("Enter the password and an encryption key of at least 16 characters");
        return;
      }
      login.disabled = true;
      login.setText("Connecting…");
      try {
        await this.plugin.startRelationshipSession(this.password, this.encryptionSecret);
        this.close();
        if (this.onReady) this.onReady();
      } catch (e) {
        console.error('Continuum relationships login', e);
        new Notice(`Could not sign in: ${e.message || e}`);
        login.disabled = false;
        login.setText("Sign in");
      }
    };
  }

  onClose() {
    blurActiveEditable();
    if (this.cleanupKeyboardDismiss) this.cleanupKeyboardDismiss();
    this.contentEl.empty();
  }
}

class NewRelationshipSituationModal extends Modal {
  constructor(app, plugin, onDone, existingSituation = null) {
    super(app);
    this.plugin = plugin;
    this.onDone = onDone;
    this.existingSituation = existingSituation;
    this.title = '';
    this.text = '';
    this.cleanupKeyboardDismiss = null;
  }

  onOpen() {
    const { contentEl } = this;
    this.cleanupKeyboardDismiss = attachMobileKeyboardDismiss(contentEl);
    this.cleanupKeyboardAvoidance = attachMobileKeyboardAvoidance(contentEl);
    contentEl.addClass('continuum-situation-editor');
    const header = contentEl.createDiv({ cls: 'continuum-situation-editor-header' });
    header.createEl('h2', { text: this.existingSituation ? "My position" : "New topic" });
    header.createEl('small', { text: moment().format('D MMMM YYYY · HH:mm') });

    if (!this.existingSituation) {
      new Setting(contentEl)
        .setName("Topic")
        .addText(text => {
          text.setPlaceholder("Briefly: what is this topic about");
          text.onChange(value => { this.title = value.trim(); });
        });
    }

    const textarea = contentEl.createEl('textarea', {
      cls: 'continuum-situation-textarea continuum-relationship-mobile-editor',
      attr: { placeholder: "Write everything you consider important…" }
    });
    textarea.addEventListener('input', () => { this.text = textarea.value; });
    setTimeout(() => textarea.focus(), 50);

    const hint = contentEl.createEl('details', { cls: 'continuum-situation-hint' });
    hint.createEl('summary', { text: "I don't know where to start" });
    hint.createEl('p', { text: "What happened? What did you feel? What affected you? What did you expect? How did you understand the other person's behavior?" });

    const actions = contentEl.createDiv({ cls: 'continuum-section-actions' });
    const cancel = actions.createEl('button', { text: "Cancel" });
    cancel.onclick = () => this.close();
    const finish = actions.createEl('button', { text: "Publish 🔒", cls: 'mod-cta' });
    finish.onclick = async () => {
      if (!this.existingSituation && !this.title) {
        new Notice("Enter a topic");
        return;
      }
      if (!this.text.trim()) {
        new Notice("The entry is empty");
        return;
      }
      if (!window.confirm("After publishing, the text cannot be changed. Publish your initial position? Your partner's text opens only after both sides have published.")) return;
      finish.disabled = true;
      finish.setText("Saving…");
      try {
        if (this.existingSituation) await this.plugin.addRelationshipEntry(this.existingSituation.id, this.text.trim());
        else await this.plugin.createRelationshipSituation(this.title, this.text.trim());
        this.close();
        new Notice("The entry is published, encrypted and locked 🔒");
        if (this.onDone) this.onDone();
      } catch (e) {
        console.error('Continuum create relationship situation', e);
        new Notice(`Could not save: ${e.message || e}`);
        finish.disabled = false;
        finish.setText("Publish 🔒");
      }
    };
  }

  onClose() {
    blurActiveEditable();
    if (this.cleanupDictation) this.cleanupDictation();
    if (this.cleanupKeyboardAvoidance) this.cleanupKeyboardAvoidance();
    if (this.cleanupKeyboardDismiss) this.cleanupKeyboardDismiss();
    this.contentEl.empty();
  }
}

class RelationshipEditTextModal extends Modal {
  constructor(app, plugin, title, initialText, onSave) {
    super(app);
    this.plugin = plugin;
    this.title = title;
    this.value = initialText || '';
    this.onSave = onSave;
    this.cleanupKeyboardDismiss = null;
    this.cleanupKeyboardAvoidance = null;
    this.cleanupDictation = null;
  }

  onOpen() {
    const { contentEl } = this;
    this.cleanupKeyboardDismiss = attachMobileKeyboardDismiss(contentEl);
    this.cleanupKeyboardAvoidance = attachMobileKeyboardAvoidance(contentEl);
    contentEl.createEl('h2', { text: this.title });
    const textarea = contentEl.createEl('textarea', { cls: 'continuum-situation-textarea continuum-relationship-mobile-editor' });
    textarea.value = this.value;
    textarea.addEventListener('input', () => { this.value = textarea.value; });
    const actions = contentEl.createDiv({ cls: 'continuum-section-actions' });
    const cancel = actions.createEl('button', { text: "Cancel" });
    cancel.onclick = () => this.close();
    const save = actions.createEl('button', { text: "Save", cls: 'mod-cta' });
    save.onclick = async () => {
      if (!this.value.trim()) return new Notice("The text cannot be empty");
      save.disabled = true;
      try {
        await this.onSave(this.value.trim());
        this.close();
      } catch (e) {
        new Notice(`Could not save: ${e.message || e}`);
        save.disabled = false;
      }
    };
    setTimeout(() => textarea.focus(), 50);
  }

  onClose() {
    blurActiveEditable();
    if (this.cleanupDictation) this.cleanupDictation();
    if (this.cleanupKeyboardAvoidance) this.cleanupKeyboardAvoidance();
    if (this.cleanupKeyboardDismiss) this.cleanupKeyboardDismiss();
    this.contentEl.empty();
  }
}

class RelationshipHistoryModal extends Modal {
  constructor(app, plugin, title, versions) {
    super(app);
    this.plugin = plugin;
    this.title = title;
    this.versions = Array.isArray(versions) ? versions : [];
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: this.title });
    if (!this.versions.length) {
      contentEl.createEl('p', { text: "No previous versions." });
      return;
    }
    for (const version of this.versions) {
      const card = contentEl.createDiv({ cls: 'continuum-message-card' });
      card.createEl('strong', { text: `Version ${version.version_number}` });
      card.createEl('small', { text: moment(version.changed_at).format('DD.MM.YYYY HH:mm') });
      try {
        const text = await this.plugin.decryptRelationshipText(version);
        card.createEl('div', { text, cls: 'continuum-perspective-text' });
      } catch (_) {
        card.createEl('div', { text: "Could not decrypt this version.", cls: 'setting-item-description' });
      }
    }
  }

  onClose() { this.contentEl.empty(); }
}


class RelationshipReplyModal extends Modal {
  constructor(app, plugin, situationId, onSent) {
    super(app);
    this.plugin = plugin;
    this.situationId = situationId;
    this.onSent = onSent;
    this.value = '';
    this.cleanupKeyboardDismiss = null;
    this.cleanupKeyboardAvoidance = null;
  }

  onOpen() {
    const { contentEl } = this;
    this.cleanupKeyboardDismiss = attachMobileKeyboardDismiss(contentEl);
    this.cleanupKeyboardAvoidance = attachMobileKeyboardAvoidance(contentEl);
    contentEl.addClass('continuum-relationship-reply-modal');

    contentEl.createEl('h2', { text: "Reply" });

    const textarea = contentEl.createEl('textarea', {
      cls: 'continuum-situation-textarea',
      attr: { placeholder: "Write a reply…" }
    });
    textarea.addEventListener('input', () => { this.value = textarea.value; });

    const actions = contentEl.createDiv({ cls: 'continuum-section-actions' });
    const cancel = actions.createEl('button', { text: "Cancel" });
    cancel.onclick = () => this.close();

    const send = actions.createEl('button', { text: "Publish", cls: 'mod-cta' });
    send.onclick = async () => {
      const value = this.value.trim();
      if (!value) return new Notice("Write a message");
      if (!window.confirm("Publish the comment? You can edit it later; the change will be marked and the previous version kept.")) return;
      send.disabled = true;
      send.setText("Publishing…");
      try {
        await this.plugin.addRelationshipMessage(this.situationId, value);
        this.close();
        if (this.onSent) await this.onSent();
      } catch (e) {
        new Notice(`Could not send: ${e.message || e}`);
        send.disabled = false;
        send.setText("Publish");
      }
    };

    setTimeout(() => textarea.focus(), 80);
  }

  onClose() {
    blurActiveEditable();
    if (this.cleanupKeyboardAvoidance) this.cleanupKeyboardAvoidance();
    if (this.cleanupKeyboardDismiss) this.cleanupKeyboardDismiss();
    this.contentEl.empty();
  }
}

class RelationshipRenameModal extends Modal {
  constructor(app, plugin, situation, currentTitle, onDone) {
    super(app);
    this.plugin = plugin;
    this.situation = situation;
    this.value = currentTitle || '';
    this.onDone = onDone;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: "Rename topic" });
    new Setting(contentEl).setName("Name").addText(text => {
      text.setValue(this.value);
      text.onChange(value => { this.value = value.trim(); });
      setTimeout(() => text.inputEl.focus(), 50);
    });
    const actions = contentEl.createDiv({ cls: 'continuum-section-actions' });
    actions.createEl('button', { text: "Cancel" }).onclick = () => this.close();
    const save = actions.createEl('button', { text: "Save", cls: 'mod-cta' });
    save.onclick = async () => {
      if (!this.value) return new Notice("The name cannot be empty");
      try {
        await this.plugin.renameRelationshipTopic(this.situation.id, this.value);
        this.close();
        if (this.onDone) this.onDone();
      } catch (e) { new Notice(`Could not rename: ${e.message || e}`); }
    };
  }
}

class RelationshipSituationModal extends Modal {
  constructor(app, plugin, situation) {
    super(app);
    this.plugin = plugin;
    this.situation = situation;
    this.cleanupKeyboardDismiss = null;
    this.cleanupKeyboardAvoidance = null;
    this.cleanupDictation = null;
  }

  async onOpen() {
    this.cleanupKeyboardDismiss = attachMobileKeyboardDismiss(this.contentEl);
    this.cleanupKeyboardAvoidance = attachMobileKeyboardAvoidance(this.contentEl);
    await this.render();
  }

  async render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('continuum-relationship-situation');
    const loading = contentEl.createEl('p', { text: "Opening topic…" });
    try {
      const fresh = await this.plugin.getRelationshipSituation(this.situation.id);
      if (fresh) this.situation = fresh;
      const [entries, messages, prefs] = await Promise.all([
        this.plugin.getRelationshipEntries(this.situation.id),
        this.plugin.getRelationshipMessages(this.situation.id).catch(() => []),
        this.plugin.getRelationshipPreferences().catch(() => [])
      ]);
      loading.remove();
      const me = this.plugin.relationshipSession.user.id;
      const own = entries.find(e => e.author_id === me);
      const other = entries.find(e => e.author_id !== me);
      const bothReady = Boolean(own && other);
      const title = await this.plugin.decodeRelationshipTitle(this.situation.title, this.situation);
      const header = contentEl.createDiv({ cls: 'continuum-topic-header' });
      const heading = header.createDiv();
      heading.createEl('h2', { text: `❤️ ${title || "Untitled"}` });
      heading.createEl('small', { text: moment(this.situation.created_at).format('D MMMM YYYY · HH:mm') });

      const status = contentEl.createDiv({ cls: `continuum-topic-status status-${this.situation.status || 'open'}` });
      status.setText(this.plugin.relationshipStatusLabel(this.situation, entries, messages));

      if (own) await this.renderEntryCard(contentEl, own, "My initial position", true, bothReady, messages, +new Date(own.updated_at || own.created_at));
      else {
        const empty = contentEl.createDiv({ cls: 'continuum-waiting-card' });
        empty.createEl('strong', { text: "Your initial position has not been written yet" });
        empty.createEl('p', { text: "Your partner's position stays hidden until you finish yours." });
        const addMine = empty.createEl('button', { text: "Write my position", cls: 'mod-cta' });
        addMine.onclick = () => {
          this.close();
          new NewRelationshipSituationModal(this.app, this.plugin, () => new RelationshipSituationModal(this.app, this.plugin, this.situation).open(), this.situation).open();
        };
      }

      if (other) await this.renderEntryCard(contentEl, other, "Partner's position", false, bothReady, messages, own ? +new Date(own.updated_at || own.created_at) : 0);
      else {
        const wait = contentEl.createDiv({ cls: 'continuum-waiting-card' });
        wait.createEl('strong', { text: "Waiting for the other side" });
        wait.createEl('p', { text: "The other position opens only after both sides finish their initial texts." });
        const refresh = wait.createEl('button', { text: "Update" });
        refresh.onclick = () => this.render();
      }

      if (bothReady) {
        const discussionBar = contentEl.createDiv({ cls: 'continuum-discussion-bar' });
        discussionBar.createEl('h3', { text: "Discussion", cls: 'continuum-discussion-title' });
        this.renderColorPicker(discussionBar, prefs, true);
        await this.renderMessages(contentEl, messages, prefs);
        await this.renderDiscussionActions(contentEl, messages);
      }
    } catch (e) {
      loading.setText(`Could not open: ${e.message || e}`);
    }
  }

  async renderEntryCard(container, entry, label, isOwn, bothReady, messages = [], ownEntryAt = 0) {
    const text = await this.plugin.decryptRelationshipText(entry);
    const color = isOwn ? (await this.plugin.getMyRelationshipColor()) : (await this.plugin.getPartnerRelationshipColor());
    const me = this.plugin.relationshipSession.user.id;
    const lastOwnReplyAt = messages.filter(m => m.author_id === me).reduce((max, m) => Math.max(max, +new Date(m.created_at)), ownEntryAt);
    const partnerActivityAt = !isOwn ? +new Date(entry.created_at) : 0;
    const partnerEntryAwaiting = !isOwn && partnerActivityAt > lastOwnReplyAt;
    const card = container.createDiv({ cls: `continuum-perspective-card continuum-author-${color || (isOwn ? 'blue' : 'green')}${partnerEntryAwaiting ? ' is-awaiting-response' : ''}` });
    const h = card.createDiv({ cls: 'continuum-message-head' });
    h.createEl('h3', { text: label });
    h.createEl('small', { text: `Published ${moment(entry.created_at).format('DD.MM.YYYY HH:mm')}` });
    card.createEl('div', { text, cls: 'continuum-perspective-text' });
  }

  renderColorPicker(container, prefs, compact = false) {
    const me = this.plugin.relationshipSession.user.id;
    const mine = prefs.find(p => p.user_id === me)?.accent_color || 'blue';
    const wrap = container.createDiv({ cls: `continuum-color-picker${compact ? ' is-compact' : ''}` });
    if (!compact) wrap.createSpan({ text: "My color:" });
    ['blue', 'green', 'purple', 'orange'].forEach(color => {
      const b = wrap.createEl('button', { cls: `continuum-color-dot color-${color}${mine === color ? ' is-active' : ''}`, attr: { 'aria-label': color } });
      b.onclick = async () => {
        try {
          await this.plugin.setRelationshipAccentColor(color);
          await this.render();
        } catch (e) { new Notice(`Could not change the color: ${e.message || e}`); }
      };
    });
    if (!compact) {
      const minePref = prefs.find(p => p.user_id === me);
      const emailEnabled = Boolean(minePref?.email_notifications_enabled);
      const emailButton = wrap.createEl('button', {
        text: emailEnabled ? "📩 Email: on" : "📩 Email: off",
        cls: `continuum-email-toggle${emailEnabled ? ' is-active' : ''}`
      });
      emailButton.onclick = async () => {
        try {
          await this.plugin.setRelationshipEmailNotificationsEnabled(!emailEnabled);
          new Notice(!emailEnabled ? "Email notifications are on" : "Email notifications are off");
          await this.render();
        } catch (e) { new Notice(`Could not change email notifications: ${e.message || e}`); }
      };
    }
  }

  async renderMessages(container, messages, prefs) {
    const me = this.plugin.relationshipSession.user.id;
    const prefMap = new Map(prefs.map(p => [p.user_id, p.accent_color]));
    const lastOwnNewReplyAt = messages.filter(m => m.author_id === me).reduce((max, m) => Math.max(max, +new Date(m.created_at)), 0);
    const list = container.createDiv({ cls: 'continuum-message-list' });
    if (!messages.length) list.createEl('p', { text: "No replies yet. You can write the first comment.", cls: 'setting-item-description' });
    for (const msg of messages) {
      const isOwn = msg.author_id === me;
      const text = await this.plugin.decryptRelationshipText(msg);
      const color = prefMap.get(msg.author_id) || (isOwn ? 'blue' : 'green');
      const effectiveAt = +new Date(msg.created_at);
      const waitingForMe = !isOwn && effectiveAt > lastOwnNewReplyAt;
      const card = list.createDiv({ cls: `continuum-message-card continuum-author-${color}${waitingForMe ? ' is-awaiting-response' : ''}` });
      const head = card.createDiv({ cls: 'continuum-message-head' });
      head.createEl('strong', { text: isOwn ? "Me" : "Partner" });
      const edited = +new Date(msg.updated_at || msg.created_at) > +new Date(msg.created_at) + 1000;
      head.createEl('small', { text: `${moment(msg.created_at).format('DD.MM.YYYY HH:mm')}${edited ? " · Edited" : ''}` });
      card.createEl('div', { text, cls: 'continuum-perspective-text' });
      const messageActions = card.createDiv({ cls: 'continuum-message-actions' });
      if (isOwn && this.situation.status !== 'closed') {
        const edit = messageActions.createEl('button', { text: "✎ Edit" });
        edit.onclick = () => new RelationshipEditTextModal(
          this.app,
          this.plugin,
          "Edit comment",
          text,
          async value => {
            await this.plugin.updateRelationshipMessage(msg.id, value);
            await this.render();
          }
        ).open();
      }
      if (edited) {
        const history = messageActions.createEl('button', { text: "Previous version" });
        history.onclick = async () => {
          try {
            const versions = await this.plugin.getRelationshipMessageVersions(msg.id);
            new RelationshipHistoryModal(this.app, this.plugin, "Comment history", versions).open();
          } catch (e) { new Notice(`Could not open the history: ${e.message || e}`); }
        };
      }
      if (!messageActions.children.length) messageActions.remove();
    }
  }

  async renderDiscussionActions(container, messages) {
    const me = this.plugin.relationshipSession.user.id;
    if (this.situation.status === 'closed') {
      const closed = container.createDiv({ cls: 'continuum-closed-card' });
      closed.createEl('strong', { text: "🔒 Topic closed" });
      closed.createEl('p', { text: "The discussion is locked. New messages are no longer possible; published texts stay unchanged." });
      return;
    }

    if (this.situation.status === 'close_requested') {
      const requesterIsMe = this.situation.close_requested_by === me;
      const closeCard = container.createDiv({ cls: 'continuum-close-request-card' });
      closeCard.createEl('strong', { text: requesterIsMe ? "Closing proposed" : "Your partner proposes closing the topic" });
      closeCard.createEl('p', { text: requesterIsMe ? "Waiting for your partner's decision." : "If the conversation is finished, confirm closing. Otherwise continue the discussion." });
      const actions = closeCard.createDiv({ cls: 'continuum-section-actions' });
      if (!requesterIsMe) {
        const confirm = actions.createEl('button', { text: "🔒 Close topic", cls: 'mod-cta' });
        confirm.onclick = async () => {
          if (!window.confirm("After closing, the topic can no longer be edited or continued. Close it?")) return;
          try { await this.plugin.confirmCloseRelationshipTopic(this.situation.id); await this.render(); }
          catch (e) { new Notice(`Could not close: ${e.message || e}`); }
        };
      }
      const cancel = actions.createEl('button', { text: requesterIsMe ? "Withdraw proposal" : "Continue the discussion" });
      cancel.onclick = async () => {
        try { await this.plugin.cancelCloseRelationshipTopic(this.situation.id); await this.render(); }
        catch (e) { new Notice(`Could not continue: ${e.message || e}`); }
      };
      return;
    }

    const actions = container.createDiv({ cls: 'continuum-section-actions continuum-discussion-actions' });
    const reply = actions.createEl('button', { text: "Reply", cls: 'mod-cta' });
    reply.onclick = () => {
      new RelationshipReplyModal(this.app, this.plugin, this.situation.id, async () => {
        await this.render();
      }).open();
    };

    const requestClose = actions.createEl('button', { text: "🔒 Propose closing the topic" });
    requestClose.onclick = async () => {
      if (!window.confirm("Propose to your partner to close this topic?")) return;
      try { await this.plugin.requestCloseRelationshipTopic(this.situation.id); await this.render(); }
      catch (e) { new Notice(`Could not propose closing: ${e.message || e}`); }
    };
  }

  onClose() {
    blurActiveEditable();
    if (this.cleanupDictation) this.cleanupDictation();
    if (this.cleanupKeyboardAvoidance) this.cleanupKeyboardAvoidance();
    if (this.cleanupKeyboardDismiss) this.cleanupKeyboardDismiss();
    this.contentEl.empty();
  }
}


class SharedCalendarItemModal extends Modal {
  constructor(app, plugin, dateString, onDone, existingItem = null, initialText = '') {
    super(app);
    this.plugin = plugin;
    this.dateString = dateString;
    this.onDone = onDone;
    this.existingItem = existingItem;
    this.value = initialText || '';
    this.cleanupKeyboardDismiss = null;
    this.cleanupKeyboardAvoidance = null;
  }

  onOpen() {
    const { contentEl } = this;
    this.cleanupKeyboardDismiss = attachMobileKeyboardDismiss(contentEl);
    this.cleanupKeyboardAvoidance = attachMobileKeyboardAvoidance(contentEl);
    contentEl.addClass('continuum-shared-calendar-editor');
    contentEl.createEl('h2', { text: this.existingItem ? "Edit plan" : "Add to plan" });
    contentEl.createEl('div', { text: moment(this.dateString, 'YYYY-MM-DD').format('D MMMM YYYY'), cls: 'continuum-shared-calendar-editor-date' });

    const textarea = contentEl.createEl('textarea', {
      cls: 'continuum-situation-textarea',
      attr: { placeholder: "What needs to be done?" }
    });
    textarea.value = this.value;
    textarea.addEventListener('input', () => { this.value = textarea.value; });

    const actions = contentEl.createDiv({ cls: 'continuum-section-actions' });
    actions.createEl('button', { text: "Cancel" }).onclick = () => this.close();
    const save = actions.createEl('button', { text: this.existingItem ? "Save" : "Add", cls: 'mod-cta' });
    save.onclick = async () => {
      const value = this.value.trim();
      if (!value) return new Notice("Write a plan item");
      save.disabled = true;
      try {
        if (this.existingItem) await this.plugin.updateSharedCalendarItem(this.existingItem.id, value);
        else await this.plugin.addSharedCalendarItem(this.dateString, value);
        this.close();
        if (this.onDone) await this.onDone();
      } catch (e) {
        new Notice(`Could not save: ${e.message || e}`);
        save.disabled = false;
      }
    };
    setTimeout(() => textarea.focus(), 80);
  }

  onClose() {
    blurActiveEditable();
    if (this.cleanupKeyboardAvoidance) this.cleanupKeyboardAvoidance();
    if (this.cleanupKeyboardDismiss) this.cleanupKeyboardDismiss();
    this.contentEl.empty();
  }
}

class SharedCalendarModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.visibleMonth = moment().startOf('month');
    this.selectedDate = moment().format('YYYY-MM-DD');
  }

  async onOpen() { await this.render(); }

  async render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('continuum-shared-calendar-modal');

    const header = contentEl.createDiv({ cls: 'continuum-shared-calendar-top' });
    header.createEl('h2', { text: "📅 Shared calendar" });
    const refresh = header.createEl('button', { text: '↻', attr: { 'aria-label': "Refresh calendar" } });
    refresh.onclick = () => this.render();

    const loading = contentEl.createEl('p', { text: "Loading calendar…", cls: 'setting-item-description' });
    try {
      const monthStart = this.visibleMonth.clone().startOf('month').format('YYYY-MM-DD');
      const monthEnd = this.visibleMonth.clone().endOf('month').format('YYYY-MM-DD');
      const items = await this.plugin.getSharedCalendarItems(monthStart, monthEnd);
      loading.remove();

      const itemsByDate = new Map();
      for (const item of items) {
        if (!itemsByDate.has(item.calendar_date)) itemsByDate.set(item.calendar_date, []);
        itemsByDate.get(item.calendar_date).push(item);
      }

      const calendar = contentEl.createDiv({ cls: 'continuum-shared-calendar-grid-wrap' });
      const monthHeader = calendar.createDiv({ cls: 'continuum-calendar-header' });
      const prev = monthHeader.createEl('button', { cls: 'continuum-calendar-nav', attr: { 'aria-label': "Previous month" } });
      setIcon(prev, 'chevron-left');
      prev.onclick = async () => { this.visibleMonth.subtract(1, 'month'); this.selectedDate = this.visibleMonth.clone().startOf('month').format('YYYY-MM-DD'); await this.render(); };
      monthHeader.createEl('strong', { text: this.visibleMonth.format('MMMM YYYY') });
      const next = monthHeader.createEl('button', { cls: 'continuum-calendar-nav', attr: { 'aria-label': "Next month" } });
      setIcon(next, 'chevron-right');
      next.onclick = async () => { this.visibleMonth.add(1, 'month'); this.selectedDate = this.visibleMonth.clone().startOf('month').format('YYYY-MM-DD'); await this.render(); };

      const weekdays = calendar.createDiv({ cls: 'continuum-weekdays' });
      moment.localeData().weekdaysMin(true).forEach(day => weekdays.createSpan({ text: day }));
      const grid = calendar.createDiv({ cls: 'continuum-days-grid' });
      const start = this.visibleMonth.clone().startOf('month').startOf('week');
      const today = moment().format('YYYY-MM-DD');
      for (let i = 0; i < 42; i += 1) {
        const date = start.clone().add(i, 'day');
        const ds = date.format('YYYY-MM-DD');
        const button = grid.createEl('button', { text: String(date.date()), cls: 'continuum-day-button continuum-shared-calendar-day' });
        if (date.month() !== this.visibleMonth.month()) button.addClass('is-outside-month');
        if (ds === today) button.addClass('is-today');
        if (ds === this.selectedDate) button.addClass('is-selected');
        if ((itemsByDate.get(ds) || []).length) button.addClass('has-shared-items');
        button.onclick = async () => {
          this.selectedDate = ds;
          if (date.month() !== this.visibleMonth.month()) this.visibleMonth = date.clone().startOf('month');
          await this.render();
        };
      }

      const dayItems = itemsByDate.get(this.selectedDate) || [];
      const dayHeader = contentEl.createDiv({ cls: 'continuum-shared-calendar-day-header' });
      const dayTitle = dayHeader.createDiv();
      dayTitle.createEl('strong', { text: moment(this.selectedDate, 'YYYY-MM-DD').format('D MMMM') });
      dayTitle.createEl('small', { text: moment(this.selectedDate, 'YYYY-MM-DD').format('dddd') });
      const add = dayHeader.createEl('button', { text: "＋ Add", cls: 'mod-cta' });
      add.onclick = () => new SharedCalendarItemModal(this.app, this.plugin, this.selectedDate, () => this.render()).open();

      const list = contentEl.createDiv({ cls: 'continuum-shared-calendar-list' });
      if (!dayItems.length) {
        list.createEl('p', { text: "No shared plans for this day yet.", cls: 'setting-item-description' });
      }

      const me = this.plugin.relationshipSession?.user?.id;
      for (const item of dayItems) {
        let decoded = '';
        try { decoded = await this.plugin.decryptRelationshipText(item); }
        catch (_) { decoded = "Could not decrypt the entry"; }
        const row = list.createDiv({ cls: `continuum-shared-calendar-item${item.is_completed ? ' is-completed' : ''}` });
        const check = row.createEl('button', { text: item.is_completed ? '☑' : '☐', cls: 'continuum-shared-calendar-check', attr: { 'aria-label': item.is_completed ? "Return to plan" : "Mark as done" } });
        check.onclick = async () => {
          try { await this.plugin.setSharedCalendarItemCompleted(item.id, !item.is_completed); await this.render(); }
          catch (e) { new Notice(`Could not change: ${e.message || e}`); }
        };
        const body = row.createDiv({ cls: 'continuum-shared-calendar-item-body' });
        body.createDiv({ text: decoded, cls: 'continuum-shared-calendar-item-text' });
        body.createEl('small', { text: item.created_by === me ? "Added by: me" : "Added by: partner" });
        const itemActions = row.createDiv({ cls: 'continuum-shared-calendar-item-actions' });
        const edit = itemActions.createEl('button', { text: '✎', attr: { 'aria-label': "Edit" } });
        edit.onclick = () => new SharedCalendarItemModal(this.app, this.plugin, this.selectedDate, () => this.render(), item, decoded).open();
        const remove = itemActions.createEl('button', { text: '×', attr: { 'aria-label': "Delete" } });
        remove.onclick = async () => {
          if (!window.confirm("Delete this item from the shared calendar?")) return;
          try { await this.plugin.deleteSharedCalendarItem(item.id); await this.render(); }
          catch (e) { new Notice(`Could not delete: ${e.message || e}`); }
        };
      }
    } catch (e) {
      loading.setText(`Could not open the calendar: ${e.message || e}`);
    }
  }

  onClose() { this.contentEl.empty(); }
}

class RelationshipsModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  async onOpen() { await this.render(); }

  async render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('continuum-relationships-modal');

    const header = contentEl.createDiv({ cls: 'continuum-library-header' });
    header.createEl('h2', { text: "❤️ Relationships" });
    const add = header.createEl('button', { text: "＋ New topic", cls: 'mod-cta' });
    add.onclick = () => new NewRelationshipSituationModal(this.app, this.plugin, () => this.render()).open();

    contentEl.createEl('p', {
      text: "Several topics can run in parallel. Initial positions stay hidden until both sides publish. All published positions and comments are immutable.",
      cls: 'setting-item-description'
    });

    const loading = contentEl.createEl('p', { text: "Loading…" });
    try {
      const situations = await this.plugin.getRelationshipSituations();
      const summaries = [];
      for (const situation of situations) summaries.push(await this.plugin.getRelationshipSituationSummary(situation));
      summaries.sort((a, b) => +new Date(b.situation?.created_at || 0) - +new Date(a.situation?.created_at || 0));
      loading.remove();
      if (!summaries.length) {
        contentEl.createEl('p', { text: "No topics yet." });
        return;
      }
      const waitingCount = summaries.filter(s => s.priority === 0).length;
      if (waitingCount) contentEl.createEl('div', { text: `● Waiting for your reply: ${waitingCount}`, cls: 'continuum-waiting-count' });
      const list = contentEl.createDiv({ cls: 'continuum-situations-list' });
      for (const summary of summaries) {
        const { situation, statusText, priority } = summary;
        const title = await this.plugin.decodeRelationshipTitle(situation.title, situation);
        const row = list.createEl('button', { cls: `continuum-situation-row priority-${priority}` });
        const top = row.createDiv({ cls: 'continuum-topic-row-top' });
        top.createEl('strong', { text: title || `Topic from ${moment(situation.created_at).format('DD.MM.YYYY')}` });
        top.createEl('span', { text: moment(situation.created_at).format('DD.MM.YYYY') });
        row.createEl('small', { text: statusText });
        row.onclick = () => new RelationshipSituationModal(this.app, this.plugin, situation).open();
      }
    } catch (e) {
      loading.setText(`Connection error: ${e.message || e}`);
    }
  }

  onClose() { this.contentEl.empty(); }
}


class ContinuumFirstRunModal extends Modal {
  constructor(app, plugin, plan, automatic = false) {
    super(app);
    this.plugin = plugin;
    this.plan = plan;
    this.automatic = automatic;
    this.busy = false;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('continuum-first-run-modal');
    contentEl.createEl('h2', { text: "CONTINUUM setup" });
    contentEl.createEl('p', {
      text: "CONTINUUM will only create missing system folders and starter pages. Existing notes and files will not be replaced.",
      cls: 'setting-item-description'
    });
    const list = contentEl.createEl('ul');
    this.plan.folders.forEach(path => list.createEl('li', { text: `Create folder: ${path}` }));
    this.plan.files.forEach(path => list.createEl('li', { text: `Create page: ${path}` }));
    if (!this.plan.folders.length && !this.plan.files.length) {
      list.createEl('li', { text: "The structure is already set up — no changes needed." });
    }
    const actions = contentEl.createDiv({ cls: 'continuum-section-actions' });
    const later = actions.createEl('button', { text: this.automatic ? "Later" : "Close" });
    later.onclick = async () => {
      if (this.automatic) {
        this.plugin.onboardingPromptDismissed = true;
        await this.plugin.saveContinuumData();
      }
      this.close();
    };
    if (this.plan.folders.length || this.plan.files.length) {
      const install = actions.createEl('button', { text: "Create structure", cls: 'mod-cta' });
      install.onclick = async () => {
        if (this.busy) return;
        this.busy = true;
        install.disabled = true;
        install.setText("Creating…");
        try {
          await this.plugin.installInitialStructure(this.plan);
          new Notice("CONTINUUM is set up. Existing files were not changed.");
          this.close();
          await this.plugin.openHomePage();
        } catch (e) {
          new Notice(`Could not finish setup: ${e.message || e}`);
          this.busy = false;
          install.disabled = false;
          install.setText("Retry");
        }
      };
    }
  }

  onClose() { this.contentEl.empty(); }
}

class ContinuumUpdateModal extends Modal {
  constructor(app, plugin, manifest) {
    super(app);
    this.plugin = plugin;
    this.manifest = manifest;
    this.busy = false;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('continuum-update-modal');
    contentEl.createEl('h2', { text: `CONTINUUM update ${this.manifest.version}` });
    contentEl.createEl('p', {
      text: `Current version: ${CONTINUUM_PLUGIN_VERSION} → new version: ${this.manifest.version}`,
      cls: 'setting-item-description'
    });
    const notes = Array.isArray(this.manifest.releaseNotes) ? this.manifest.releaseNotes : [];
    if (notes.length) {
      const list = contentEl.createEl('ul');
      notes.forEach(note => list.createEl('li', { text: String(note) }));
    }
    contentEl.createEl('p', {
      text: this.manifest.touchesUserData
        ? "This update declares changes to user data. Automatic installation is blocked until a separate safe migration."
        : "Only CONTINUUM system files will be updated. Notes, journals, attachments and \"Relationships\" data are not part of the update package.",
      cls: 'setting-item-description'
    });
    contentEl.createEl('p', {
      text: `System files: ${CONTINUUM_UPDATE_ALLOWED_FILES.join(', ')}. Personal files are not part of the package.`,
      cls: 'setting-item-description'
    });
    if (this.manifest.requiresSupabaseMigration) {
      contentEl.createEl('p', { text: "⚠️ This version also requires the administrator to update the shared space. This is not done automatically.", cls: 'setting-item-description' });
    }
    const actions = contentEl.createDiv({ cls: 'continuum-update-actions' });
    const cancel = actions.createEl('button', { text: "Cancel" });
    cancel.onclick = () => this.close();
    if (!this.manifest.touchesUserData && !this.manifest.requiresSupabaseMigration) {
      const noBackup = actions.createEl('button', { text: "Update without a backup" });
      noBackup.onclick = () => this.install(false);
      const withBackup = actions.createEl('button', { text: "Back up and update", cls: 'mod-cta' });
      withBackup.onclick = () => this.install(true);
    }
  }

  async install(createBackup) {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.plugin.installContinuumUpdate(this.manifest, createBackup);
      this.close();
    } catch (e) {
      console.error('Continuum update failed', e);
      new Notice(`The update was not installed: ${e.message || e}`);
      this.busy = false;
    }
  }

  onClose() { this.contentEl.empty(); }
}

class ContinuumSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    attachMobileKeyboardDismiss(containerEl);
    containerEl.createEl('h2', { text: 'CONTINUUM' });
    containerEl.createEl('h3', { text: "🧭 System and updates" });
    containerEl.createEl('p', {
      text: "CONTINUUM code and user data are separate. Updating system files does not need a new space and must not touch notes, journals, attachments or created sections.",
      cls: 'setting-item-description'
    });

    new Setting(containerEl)
      .setName("CONTINUUM version")
      .setDesc(`Plugin ${CONTINUUM_PLUGIN_VERSION} · data schema ${this.plugin.dataSchemaVersion || CONTINUUM_DATA_SCHEMA_VERSION}`);

    new Setting(containerEl)
      .setName("Update channel")
      .setDesc("Leave empty to receive general updates. Enter the name you were given to also receive personal updates. Then tap \"Check for updates\".")
      .addText(text => text
        .setPlaceholder("e.g. anna")
        .setValue(this.plugin.updateSettings?.channelId || '')
        .onChange(async value => {
          this.plugin.updateSettings.channelId = sanitizeUpdateChannel(value);
          await this.plugin.saveContinuumData();
        }));

    const updateStatus = new Setting(containerEl)
      .setName("Update status")
      .setDesc("Checking…");
    this.plugin.fetchUpdateManifest().then(manifest => {
      if (compareVersions(manifest.version, CONTINUUM_PLUGIN_VERSION) > 0) {
        updateStatus.setName("🔔 Update available").setDesc(`New version ${manifest.version} (currently ${CONTINUUM_PLUGIN_VERSION})`);
        updateStatus.addButton(button => button.setButtonText("Update").setCta().onClick(() => {
          new ContinuumUpdateModal(this.app, this.plugin, manifest).open();
        }));
      } else {
        updateStatus.setDesc("You have the latest version");
      }
    }).catch(() => updateStatus.setDesc("Could not check (no internet or no updates published yet)"));

    new Setting(containerEl)
      .setName("Update check")
      .setDesc("Checks whether a new version is available. Notes, attachments, passwords and keys are not part of the update package.")
      .addButton(button => button
        .setButtonText("Check for updates")
        .onClick(async () => {
          button.setDisabled(true).setButtonText("Checking…");
          try { await this.plugin.checkForContinuumUpdates({ openModal: true, silent: false }); }
          finally { button.setDisabled(false).setButtonText("Check for updates"); }
        }));

    new Setting(containerEl)
      .setName("Restore previous version")
      .setDesc("Restores the last saved system version after an update. Personal notes are not affected.")
      .addButton(button => button.setButtonText("Restore").onClick(async () => {
        button.setDisabled(true);
        try { await this.plugin.restorePreviousContinuumVersion(); }
        finally { button.setDisabled(false); }
      }));

    new Setting(containerEl)
      .setName("Safe support report")
      .setDesc("Creates a technical report without texts, personal file names, attachments, passwords or keys.")
      .addButton(button => button.setButtonText("Create report").onClick(async () => {
        button.setDisabled(true);
        try { await this.plugin.createSupportReport(); }
        finally { button.setDisabled(false); }
      }));

    new Setting(containerEl)
      .setName("CONTINUUM structure")
      .setDesc("Shows missing starter folders and pages before creating them. Existing files are not replaced.")
      .addButton(button => button.setButtonText("Check").onClick(() => this.plugin.openInitialSetup(false)));

    new Setting(containerEl)
      .setName("Check for updates automatically")
      .setDesc("Only checks for a new version on startup. Installing always needs your confirmation.")
      .addToggle(toggle => toggle
        .setValue(this.plugin.updateSettings?.autoCheck === true)
        .onChange(async value => {
          this.plugin.updateSettings.autoCheck = value;
          await this.plugin.saveContinuumData();
        }));

    new Setting(containerEl)
      .setName("Date format in personal sections")
      .setDesc("New links are shown as DD.MM.YYYY, while the technical name of the daily file stays YYYY-MM-DD.")
      .addButton(button => button
        .setButtonText("Update old links")
        .onClick(async () => {
          const changed = await this.plugin.migrateJournalDateAliases();
          new Notice(changed ? `Sections updated: ${changed}` : "No old dates to change were found");
        }));

    containerEl.createEl('h3', { text: "❤️ Together" });
    containerEl.createEl('p', {
      text: this.plugin.relationshipConfigured()
        ? "The connection is set up by the administrator. The \"Relationships\" and \"Calendar\" sections are available after the user signs in."
        : "The \"Relationships\" and \"Calendar\" sections are not available yet. The second participant is connected by the CONTINUUM administrator.",
      cls: 'setting-item-description'
    });
    if (this.plugin.relationshipConfigured()) {
      new Setting(containerEl)
        .setName("Participant")
        .setDesc(this.plugin.relationshipSettings.email || "Connected by the administrator");
    }

    new Setting(containerEl)
      .setName("Remember sign-in on this device")
      .setDesc("If enabled, sign-in data and the encryption key are kept on this device for up to 12 hours. Do not enable on someone else's or a shared device.")
      .addToggle(toggle => toggle
        .setValue(this.plugin.relationshipSettings.rememberSession === true)
        .onChange(async value => {
          this.plugin.relationshipSettings.rememberSession = value;
          if (!value && this.plugin.app?.secretStorage?.setSecret) {
            try { await Promise.resolve(this.plugin.app.secretStorage.setSecret(CONTINUUM_SHARED_SESSION_SECRET_ID, '')); } catch (_) {}
          }
          await this.plugin.saveContinuumData();
        }));

    new Setting(containerEl)
      .setName("End current session")
      .setDesc("Removes the current sign-in data and encryption key from the app's memory.")
      .addButton(button => button.setButtonText("Sign out").onClick(async () => {
        button.setDisabled(true);
        await this.plugin.endRelationshipSession();
        new Notice("The shared-space session has ended and been revoked");
        button.setDisabled(false);
      }));
  }
}

class ContinuumSidebarView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.visibleMonth = moment().startOf('month');
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'CONTINUUM'; }
  // `compass` is the name of a standard Obsidian/Lucide icon, not a link to
  // the former product. Keep it so the CONTINUUM visual identity is unchanged.
  getIcon() { return 'compass'; }
  async onOpen() {
    this.motivationIndex = 0;
    this.render();
    this.motivationTimer = window.setInterval(() => this.showNextMotivation(), 60000);
  }

  async onClose() {
    if (this.motivationTimer) window.clearInterval(this.motivationTimer);
  }

  render() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('continuum-sidebar');

    const title = container.createDiv({ cls: 'continuum-sidebar-title' });
    const icon = title.createSpan({ cls: 'continuum-logo' });
    setIcon(icon, 'compass');
    const brand = title.createDiv({ cls: 'continuum-brand-lockup' });
    brand.createDiv({ text: 'CONTINUUM', cls: 'continuum-brand-name' });
    const tagline = brand.createDiv({ cls: 'continuum-brand-tagline', attr: { 'aria-label': 'Your days. Your plans. Your life.' } });
    tagline.createSpan({ text: 'Your days.' });
    tagline.createSpan({ text: 'Your plans.' });
    tagline.createSpan({ text: 'Your life.' });

    const motivationCard = container.createDiv({ cls: 'continuum-motivation-card is-empty' });
    motivationCard.createDiv({ text: "✨ Motivation", cls: 'continuum-motivation-label' });
    this.motivationCardEl = motivationCard;
    this.motivationTextEl = motivationCard.createDiv({ cls: 'continuum-motivation-text' });
    motivationCard.onclick = () => this.plugin.openMotivation();
    this.refreshMotivation();

    const todayButton = container.createEl('button', { text: "Open today", cls: 'continuum-today-button' });
    todayButton.onclick = () => this.plugin.openDate(moment());

    const calendar = container.createDiv({ cls: 'continuum-calendar' });
    const header = calendar.createDiv({ cls: 'continuum-calendar-header' });
    const previous = header.createEl('button', { cls: 'continuum-calendar-nav', attr: { 'aria-label': "Previous month" } });
    setIcon(previous, 'chevron-left');
    previous.onclick = () => { this.visibleMonth.subtract(1, 'month'); this.render(); };
    header.createEl('strong', { text: this.visibleMonth.format('MMMM YYYY') });
    const next = header.createEl('button', { cls: 'continuum-calendar-nav', attr: { 'aria-label': "Next month" } });
    setIcon(next, 'chevron-right');
    next.onclick = () => { this.visibleMonth.add(1, 'month'); this.render(); };

    const weekdays = calendar.createDiv({ cls: 'continuum-weekdays' });
    moment.localeData().weekdaysMin(true).forEach(day => weekdays.createSpan({ text: day }));

    const grid = calendar.createDiv({ cls: 'continuum-days-grid' });
    const start = this.visibleMonth.clone().startOf('month').startOf('week');
    const today = moment().format('YYYY-MM-DD');
    for (let i = 0; i < 42; i += 1) {
      const date = start.clone().add(i, 'day');
      const dateString = date.format('YYYY-MM-DD');
      const button = grid.createEl('button', { text: String(date.date()), cls: 'continuum-day-button' });
      if (date.month() !== this.visibleMonth.month()) button.addClass('is-outside-month');
      if (dateString === today) button.addClass('is-today');
      if (this.plugin.hasDaily(dateString)) button.addClass('has-note');
      button.onclick = () => this.plugin.openDate(date);
    }

    this.addDivider(container, "Personal");
    const journalNav = container.createDiv({ cls: 'continuum-nav' });
    this.addNavButton(journalNav, '🏠', "Home", () => this.plugin.openTarget('Home.md'));
    this.addNavButton(journalNav, '✨', "Motivation", () => this.plugin.openMotivation());
    BUILTIN_JOURNALS.forEach(([emoji, name]) => {
      const id = `journal:${name}`;
      if (this.plugin.isBuiltinHidden(id)) return;
      const section = { source: 'builtin', builtinId: id, type: 'journal', emoji, name, journal: name };
      this.addNavButton(journalNav, emoji, name, () => this.plugin.openJournal(name, emoji), () => this.plugin.manageSection(section));
    });
    this.plugin.getCustomJournals().forEach(section => {
      const descriptor = { ...section, source: 'custom' };
      this.addNavButton(journalNav, section.emoji, section.name, () => this.plugin.openTarget(`03 Journals/${section.journal}.md`), () => this.plugin.manageSection(descriptor));
    });
    const addPersonalSectionButton = container.createEl('button', { text: "＋ Add section", cls: 'continuum-sidebar-add' });
    addPersonalSectionButton.onclick = () => this.plugin.openAddSection('journal');

    this.addDivider(container, "Together");
    const sharedNav = container.createDiv({ cls: 'continuum-nav continuum-shared-nav' });
    const sharedReady = this.plugin.relationshipConfigured();
    const sharedDisabledReason = "The second participant is connected by the CONTINUUM administrator.";
    this.addNavButton(sharedNav, '❤️', "Relationships", () => this.plugin.openRelationships(), null, {
      disabled: !sharedReady,
      title: sharedDisabledReason
    });
    this.addNavButton(sharedNav, '📅', "Calendar", () => this.plugin.openSharedCalendar(), null, {
      disabled: !sharedReady,
      title: sharedDisabledReason
    });
    if (!sharedReady) sharedNav.createDiv({ text: sharedDisabledReason, cls: 'continuum-shared-hint' });

    this.addDivider(container, "Projects & knowledge");
    const libraryNav = container.createDiv({ cls: 'continuum-nav' });
    this.plugin.getCustomLibraries().forEach(section => {
      const descriptor = { ...section, source: 'custom' };
      this.addNavButton(libraryNav, section.emoji, section.name, () => this.plugin.openLibrary(section.folder, section.emoji, section.name), () => this.plugin.manageSection(descriptor));
    });
    this.addNavButton(libraryNav, '📦', "Archive", () => this.plugin.openArchive());

    const addKnowledgeSectionButton = container.createEl('button', { text: "＋ Add section", cls: 'continuum-sidebar-add' });
    addKnowledgeSectionButton.onclick = () => this.plugin.openAddSection('library');
    const hint = container.createEl('div', { text: "Press and hold a section to move it to the Archive.", cls: 'continuum-sidebar-hint' });
  }

  async refreshMotivation() {
    const motivations = await this.plugin.getMotivations();
    if (!this.motivationTextEl || !this.motivationCardEl) return;
    if (!motivations.length) {
      this.motivationTextEl.setText('');
      this.motivationCardEl.addClass('is-empty');
      return;
    }
    this.motivationCardEl.removeClass('is-empty');
    this.motivationIndex = Math.min(this.motivationIndex || 0, motivations.length - 1);
    this.motivationTextEl.setText(motivations[this.motivationIndex]);
  }

  async showNextMotivation() {
    const motivations = await this.plugin.getMotivations();
    if (!this.motivationTextEl || !motivations.length) return;
    this.motivationIndex = ((this.motivationIndex || 0) + 1) % motivations.length;
    this.motivationTextEl.addClass('is-changing');
    window.setTimeout(() => {
      if (!this.motivationTextEl) return;
      this.motivationTextEl.setText(motivations[this.motivationIndex]);
      this.motivationTextEl.removeClass('is-changing');
    }, 180);
  }

  addDivider(container, text) {
    const divider = container.createDiv({ cls: 'continuum-divider' });
    divider.createSpan({ text });
  }

  addNavButton(parent, emoji, label, onClick, onManage = null, options = {}) {
    const button = parent.createEl('button', { cls: 'continuum-nav-button' });
    button.createSpan({ text: emoji, cls: 'continuum-nav-emoji' });
    button.createSpan({ text: label });

    if (options.disabled) {
      button.disabled = true;
      button.addClass('is-disabled');
      button.setAttribute('aria-disabled', 'true');
      if (options.title) button.setAttribute('title', options.title);
      return button;
    }

    let longPressTimer = null;
    let suppressClick = false;
    const cancelLongPress = () => {
      if (longPressTimer) window.clearTimeout(longPressTimer);
      longPressTimer = null;
    };

    button.onclick = event => {
      if (suppressClick) {
        suppressClick = false;
        event.preventDefault();
        return;
      }
      onClick();
    };

    if (onManage) {
      button.addEventListener('contextmenu', event => {
        event.preventDefault();
        onManage();
      });
      button.addEventListener('touchstart', () => {
        cancelLongPress();
        longPressTimer = window.setTimeout(() => {
          suppressClick = true;
          onManage();
        }, 600);
      }, { passive: true });
      button.addEventListener('touchend', cancelLongPress, { passive: true });
      button.addEventListener('touchcancel', cancelLongPress, { passive: true });
      button.addEventListener('touchmove', cancelLongPress, { passive: true });
    }
    return button;
  }
}


/* Configurable knowledge-base workflows. */
class ContinuumRenameModal extends Modal {
  constructor(app, plugin, title, initialValue, onSave) {
    super(app); this.plugin = plugin; this.title = title; this.value = initialValue || ''; this.onSave = onSave;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: this.title });
    new Setting(contentEl).setName("Name").addText(input => {
      input.setValue(this.value); input.onChange(v => { this.value = v.trim(); });
      setTimeout(() => input.inputEl.focus(), 50);
    });
    const actions = contentEl.createDiv({ cls: 'continuum-section-actions' });
    actions.createEl('button', { text: "Cancel" }).onclick = () => this.close();
    const save = actions.createEl('button', { text: "Save", cls: 'mod-cta' });
    save.onclick = async () => {
      if (!this.value) return new Notice("The name cannot be empty");
      try { await this.onSave(this.value); this.close(); } catch (e) { new Notice(`Could not save: ${e.message || e}`); }
    };
  }
}

class ContinuumLibraryFolderSettingsModal extends Modal {
  constructor(app, plugin, folderPath, label, onDone) {
    super(app); this.plugin = plugin; this.folderPath = folderPath; this.label = label; this.onDone = onDone;
  }
  onOpen() { this.render(); }
  render() {
    const { contentEl } = this; contentEl.empty();
    const feature = this.plugin.getLibraryFeature(this.folderPath);
    contentEl.createEl('h2', { text: `⚙️ ${this.label}` });
    contentEl.createEl('p', { text: "All features below are optional and apply to this folder only.", cls: 'setting-item-description' });
    new Setting(contentEl).setName("Show in the daily planner").setDesc("Lets you choose this folder via \"＋ Add block → 📚 Projects & knowledge\".").addToggle(t => t.setValue(!!feature.showInDaily).onChange(v => this.plugin.setLibraryFeature(this.folderPath, { showInDaily: v })));
    new Setting(contentEl).setName("Collect entries from days").setDesc("The folder will get links to entries created from the daily notes. The original text stays in the daily note.").addToggle(t => t.setValue(!!feature.collectDaily).onChange(v => this.plugin.setLibraryFeature(this.folderPath, { collectDaily: v })));
    new Setting(contentEl).setName("Show checkboxes").setDesc("Handy for task lists: an item can be marked as done without deleting the daily entry.").addToggle(t => t.setValue(!!feature.checklistMode).onChange(v => this.plugin.setLibraryFeature(this.folderPath, { checklistMode: v })));
    new Setting(contentEl).setName("Generate folders by period").setDesc("Adds a button that collects related entries for a chosen date range into a separate subfolder.").addToggle(t => t.setValue(!!feature.periodGrouping).onChange(v => this.plugin.setLibraryFeature(this.folderPath, { periodGrouping: v })));
    const done = contentEl.createEl('button', { text: "Done", cls: 'mod-cta' });
    done.onclick = () => { this.close(); if (this.onDone) this.onDone(); };
  }
}

class ContinuumLibraryItemActionsModal extends Modal {
  constructor(app, plugin, item, onDone) { super(app); this.plugin = plugin; this.item = item; this.onDone = onDone; }
  onOpen() {
    const { contentEl } = this; const isFolder = Array.isArray(this.item.children); const name = isFolder ? this.item.name : this.item.basename;
    contentEl.createEl('h2', { text: `${isFolder ? '📁' : '📄'} ${name}` });
    const rename = contentEl.createEl('button', { text: "✏️ Rename", cls: 'continuum-secondary-action' });
    rename.onclick = () => new ContinuumRenameModal(this.app, this.plugin, "Rename", name, async value => {
      await this.plugin.renameLibraryItem(this.item, value); this.close(); if (this.onDone) this.onDone();
    }).open();
    if (isFolder) {
      const settings = contentEl.createEl('button', { text: "⚙️ Folder settings", cls: 'continuum-secondary-action' });
      settings.onclick = () => new ContinuumLibraryFolderSettingsModal(this.app, this.plugin, this.item.path, this.item.name, () => { this.close(); if (this.onDone) this.onDone(); }).open();
    } else {
      const convert = contentEl.createEl('button', { text: "📁 Turn note into folder", cls: 'continuum-secondary-action' });
      convert.onclick = async () => {
        if (!window.confirm("Create a folder with this name? The note text, if any, will be kept inside the new folder.")) return;
        try { await this.plugin.convertLibraryNoteToFolder(this.item); this.close(); if (this.onDone) this.onDone(); } catch (e) { new Notice(`Could not convert: ${e.message || e}`); }
      };
    }
    const remove = contentEl.createEl('button', { text: isFolder ? "🗑 Delete folder" : "🗑 Delete note", cls: 'continuum-danger-action' });
    remove.onclick = async () => {
      const children = isFolder && Array.isArray(this.item.children) ? this.item.children.length : 0;
      const warning = children ? `This folder contains ${children} item(s). Delete the folder with all its contents? Daily entries will stay.` : `Delete "${name}"?`;
      if (!window.confirm(warning)) return;
      try { await this.plugin.deleteLibraryItem(this.item); this.close(); if (this.onDone) this.onDone(); } catch (e) { new Notice(`Could not delete: ${e.message || e}`); }
    };
    contentEl.createEl('button', { text: "Cancel", cls: 'continuum-secondary-action' }).onclick = () => this.close();
  }
}

class ContinuumPeriodModal extends Modal {
  constructor(app, plugin, path, onDone) { super(app); this.plugin = plugin; this.path = path; this.onDone = onDone; this.start = ''; this.end = ''; }
  onOpen() {
    const { contentEl } = this; contentEl.createEl('h2', { text: "🗓 Generate period" });
    contentEl.createEl('p', { text: "Creates a subfolder with the date range and moves only the links to related entries there. The daily notes themselves stay in place.", cls: 'setting-item-description' });
    new Setting(contentEl).setName("Start").addText(i => { i.inputEl.type = 'date'; i.onChange(v => this.start = v); });
    new Setting(contentEl).setName("End").addText(i => { i.inputEl.type = 'date'; i.onChange(v => this.end = v); });
    const actions = contentEl.createDiv({ cls: 'continuum-section-actions' }); actions.createEl('button', { text: "Cancel" }).onclick = () => this.close();
    const create = actions.createEl('button', { text: "Generate", cls: 'mod-cta' });
    create.onclick = async () => {
      if (!this.start || !this.end) return new Notice("Specify both dates");
      if (this.end < this.start) return new Notice("The end of the period is before the start");
      try { const count = await this.plugin.formLibraryPeriod(this.path, this.start, this.end); this.close(); new Notice(`Period created · entries: ${count}`); if (this.onDone) this.onDone(); } catch (e) { new Notice(`Error: ${e.message || e}`); }
    };
  }
}

class ContinuumDailyLibraryEntryModal extends Modal {
  constructor(app, plugin, targetPath) { super(app); this.plugin = plugin; this.targetPath = targetPath; this.value = ''; this.cleanupKeyboardAvoidance = null; }
  onOpen() {
    const { contentEl } = this; this.cleanupKeyboardAvoidance = attachMobileKeyboardAvoidance(contentEl); const name = this.targetPath.split('/').pop();
    contentEl.createEl('h2', { text: `📚 ${name}` });
    const textarea = contentEl.createEl('textarea', { cls: 'continuum-situation-textarea', attr: { placeholder: "Write a thought, task or observation…" } });
    textarea.addEventListener('input', () => this.value = textarea.value); setTimeout(() => textarea.focus(), 50);
    const actions = contentEl.createDiv({ cls: 'continuum-section-actions' }); actions.createEl('button', { text: "Cancel" }).onclick = () => this.close();
    const save = actions.createEl('button', { text: "Add to day", cls: 'mod-cta' });
    save.onclick = async () => { if (!this.value.trim()) return new Notice("The entry is empty"); save.disabled = true; try { await this.plugin.addLibraryDailyEntry(this.targetPath, this.value.trim()); this.close(); } catch (e) { save.disabled = false; new Notice(`Error: ${e.message || e}`); } };
  }
  onClose() { blurActiveEditable(); if (this.cleanupKeyboardAvoidance) this.cleanupKeyboardAvoidance(); this.contentEl.empty(); }
}

class ContinuumLibraryTargetModal extends Modal {
  constructor(app, plugin, currentPath = null, root = null) { super(app); this.plugin = plugin; this.currentPath = currentPath; this.root = root; }
  onOpen() { this.render(); }
  render() {
    const { contentEl } = this; contentEl.empty(); contentEl.createEl('h2', { text: "📚 Where to add the entry?" });
    if (!this.currentPath) {
      const roots = this.plugin.getDailyLibraryRoots();
      if (!roots.length) { contentEl.createEl('p', { text: "First turn on \"Show in the daily planner\" in the settings of the folder you need." }); return; }
      const list = contentEl.createDiv({ cls: 'continuum-library-list' });
      roots.forEach(section => { const b = list.createEl('button', { cls: 'continuum-library-entry continuum-library-folder' }); b.createSpan({ text: section.emoji || '📚' }); b.createSpan({ text: section.name, cls: 'continuum-library-entry-name' }); b.createSpan({ text: '›' }); b.onclick = () => { this.root = section; this.currentPath = section.folder; this.render(); }; });
      return;
    }
    const currentName = this.currentPath.split('/').pop();
    const nav = contentEl.createDiv({ cls: 'continuum-library-target-nav' }); const back = nav.createEl('button', { text: "← Back" }); nav.createSpan({ text: currentName });
    back.onclick = () => { if (this.currentPath === this.root.folder) { this.currentPath = null; this.root = null; } else this.currentPath = this.currentPath.split('/').slice(0, -1).join('/'); this.render(); };
    if (this.plugin.getLibraryFeature(this.currentPath).showInDaily) {
      const choose = contentEl.createEl('button', { text: `✓ Choose "${currentName}"`, cls: 'mod-cta continuum-library-target-choose' });
      choose.onclick = () => { const p = this.currentPath; this.close(); new ContinuumDailyLibraryEntryModal(this.app, this.plugin, p).open(); };
    }
    const folder = this.app.vault.getAbstractFileByPath(this.currentPath); const folders = folder && Array.isArray(folder.children) ? folder.children.filter(x => Array.isArray(x.children) && this.plugin.libraryHasDailyTargets(x.path)).sort((a,b) => a.name.localeCompare(b.name,'en')) : [];
    const list = contentEl.createDiv({ cls: 'continuum-library-list' });
    folders.forEach(item => { const b = list.createEl('button', { cls: 'continuum-library-entry continuum-library-folder' }); b.createSpan({ text: '📁' }); b.createSpan({ text: item.name, cls: 'continuum-library-entry-name' }); b.createSpan({ text: '›' }); b.onclick = () => { this.currentPath = item.path; this.render(); }; });
  }
}

class AddMotivationModal extends Modal {
  constructor(app, plugin, onSaved) {
    super(app);
    this.plugin = plugin;
    this.onSaved = onSaved;
    this.value = '';
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('continuum-motivation-entry-modal');
    contentEl.createEl('h2', { text: "✨ New motivation" });
    contentEl.createEl('p', {
      text: "Save words, a conclusion or a reminder you want to keep in front of you.",
      cls: 'setting-item-description'
    });
    new Setting(contentEl)
      .setName("Text")
      .addTextArea(text => {
        text.setPlaceholder("What is important not to forget?");
        text.inputEl.rows = 5;
        text.inputEl.addClass('continuum-motivation-input');
        text.onChange(value => { this.value = value; });
        window.setTimeout(() => text.inputEl.focus(), 80);
      });

    const actions = contentEl.createDiv({ cls: 'continuum-section-actions' });
    actions.createEl('button', { text: "Cancel" }).onclick = () => this.close();
    const save = actions.createEl('button', { text: "Add", cls: 'mod-cta' });
    save.onclick = async () => {
      save.disabled = true;
      const ok = await this.plugin.addMotivation(this.value);
      if (!ok) {
        save.disabled = false;
        return;
      }
      this.close();
      if (this.onSaved) await this.onSaved();
    };
  }

  onClose() { this.contentEl.empty(); }
}

class ContinuumMotivationManagerModal extends Modal {
  constructor(app, plugin) { super(app); this.plugin = plugin; }
  async onOpen() { await this.render(); }
  async render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('continuum-motivation-manager-modal');
    contentEl.createEl('h2', { text: "✨ Motivation" });
    contentEl.createEl('p', {
      text: "Words, conclusions and lived experience worth remembering. Visible phrases appear in turn in the sidebar.",
      cls: 'setting-item-description'
    });
    const add = contentEl.createEl('button', { text: "＋ Add motivation", cls: 'mod-cta continuum-motivation-add' });
    add.onclick = () => new AddMotivationModal(this.app, this.plugin, async () => this.render()).open();

    const all = await this.plugin.getMotivations({ includeHidden: true });
    if (!all.length) {
      contentEl.createEl('p', { text: "Nothing added yet.", cls: 'setting-item-description' });
      return;
    }

    const hidden = new Set(this.plugin.hiddenMotivations || []);
    for (const motivation of all) {
      const isHidden = hidden.has(motivation);
      const row = contentEl.createDiv({ cls: `continuum-motivation-manager-row${isHidden ? ' is-hidden' : ''}` });
      row.createDiv({ text: motivation, cls: 'continuum-motivation-manager-text' });
      const toggle = row.createEl('button', {
        text: isHidden ? '↩' : '✕',
        cls: 'continuum-motivation-toggle',
        attr: { 'aria-label': isHidden ? "Show again" : "Hide from display" }
      });
      toggle.onclick = async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await this.plugin.setMotivationVisible(motivation, isHidden);
        await this.render();
        this.plugin.refreshSidebar();
      };
    }
  }
}

// Extra entry in the daily chooser.
const continuumChoiceBaseOnOpen = ChoiceModal.prototype.onOpen;
ChoiceModal.prototype.onOpen = function() {
  continuumChoiceBaseOnOpen.call(this);
  if (!this.plugin.hasDailyLibraryTargets()) return;
  const grid = this.contentEl.querySelector('.continuum-grid'); if (!grid) return;
  const button = grid.createEl('button', { text: "📚 Projects & knowledge", cls: 'continuum-choice' });
  button.onclick = () => { this.close(); new ContinuumLibraryTargetModal(this.app, this.plugin).open(); };
};

// Keyboard protection for forms that were still hidden behind iOS keyboard.
for (const Klass of [AddSectionModal, NewDocumentModal, NewLibraryFolderModal, RelationshipSessionModal, AddMotivationModal]) {
  const oldOpen = Klass.prototype.onOpen; const oldClose = Klass.prototype.onClose;
  Klass.prototype.onOpen = function() { oldOpen.call(this); this.__continuum220KeyboardAvoid = attachMobileKeyboardAvoidance(this.contentEl); };
  Klass.prototype.onClose = function() { if (this.__continuum220KeyboardAvoid) this.__continuum220KeyboardAvoid(); if (oldClose) oldClose.call(this); };
}

// Open motivation visibility manager from the rotating card.
const continuumSidebarBaseRender = ContinuumSidebarView.prototype.render;
ContinuumSidebarView.prototype.render = function() {
  continuumSidebarBaseRender.call(this);
  const card = this.containerEl.querySelector('.continuum-motivation-card');
  if (card) card.onclick = () => new ContinuumMotivationManagerModal(this.app, this.plugin).open();
};

// Knowledge-base browser with per-item management and linked daily entries.
LibraryModal.prototype.render = function() {
  const { contentEl } = this; contentEl.empty(); contentEl.addClass('continuum-library-modal');
  const header = contentEl.createDiv({ cls: 'continuum-library-header continuum-library-browser-header' }); const titleWrap = header.createDiv({ cls: 'continuum-library-title-wrap' });
  titleWrap.createEl('h2', { text: `${this.emoji} ${this.currentPath === this.rootPath ? this.label : this.currentPath.split('/').pop()}` });
  if (this.currentPath !== this.rootPath) { const up = header.createEl('button', { text: "← Back", cls: 'continuum-library-back' }); up.onclick = () => { const parent = this.currentPath.split('/').slice(0,-1).join('/'); this.openFolder(parent.startsWith(this.rootPath) ? parent : this.rootPath); }; }
  this.renderBreadcrumbs(contentEl);
  const createBar = contentEl.createDiv({ cls: 'continuum-library-create-bar' });
  createBar.createEl('button', { text: "＋ Folder", cls: 'mod-cta' }).onclick = () => new NewLibraryFolderModal(this.app, this.plugin, this.currentPath, () => this.render()).open();
  createBar.createEl('button', { text: "＋ Note" }).onclick = () => new NewDocumentModal(this.app, this.plugin, this.currentPath, async file => await this.app.workspace.getLeaf(false).openFile(file)).open();
  createBar.createEl('button', { text: "⚙️ Folder" }).onclick = () => new ContinuumLibraryFolderSettingsModal(this.app, this.plugin, this.currentPath, this.currentPath.split('/').pop(), () => this.render()).open();
  if (this.plugin.getLibraryFeature(this.currentPath).periodGrouping) createBar.createEl('button', { text: "🗓 Period" }).onclick = () => new ContinuumPeriodModal(this.app, this.plugin, this.currentPath, () => this.render()).open();
  const folder = this.app.vault.getAbstractFileByPath(this.currentPath); const children = folder && Array.isArray(folder.children) ? [...folder.children] : [];
  const folders = children.filter(i => Array.isArray(i.children)).sort((a,b)=>a.name.localeCompare(b.name,'en')); const files = children.filter(i => i.extension === 'md' && !/^README$/i.test(i.basename)).sort((a,b)=>a.basename.localeCompare(b.basename,'en')); const linked = this.plugin.getLibraryDailyLinks(this.currentPath);
  if (!folders.length && !files.length && !linked.length) { contentEl.createEl('p', { text: "The folder is empty.", cls: 'setting-item-description' }); return; }
  const list = contentEl.createDiv({ cls: 'continuum-library-list continuum-library-tree-list' });
  const attachManage = (button, item) => { let timer=null, suppress=false; const clear=()=>{ if(timer) window.clearTimeout(timer); timer=null; }; button.addEventListener('contextmenu', e=>{e.preventDefault(); new ContinuumLibraryItemActionsModal(this.app,this.plugin,item,()=>this.render()).open();}); button.addEventListener('touchstart',()=>{clear();timer=window.setTimeout(()=>{suppress=true;new ContinuumLibraryItemActionsModal(this.app,this.plugin,item,()=>this.render()).open();},600);},{passive:true}); for(const ev of ['touchend','touchcancel','touchmove']) button.addEventListener(ev,clear,{passive:true}); return ()=>{if(suppress){suppress=false;return true;}return false;}; };
  folders.forEach(item=>{ const b=list.createEl('button',{cls:'continuum-library-entry continuum-library-folder'}); b.createSpan({text:'📁',cls:'continuum-library-entry-icon'}); b.createSpan({text:item.name,cls:'continuum-library-entry-name'}); b.createSpan({text:'›',cls:'continuum-library-entry-chevron'}); const sup=attachManage(b,item); b.onclick=()=>{if(!sup())this.openFolder(item.path);}; });
  files.forEach(file=>{ const b=list.createEl('button',{cls:'continuum-library-entry continuum-library-note'}); b.createSpan({text:'📄',cls:'continuum-library-entry-icon'}); b.createSpan({text:file.basename,cls:'continuum-library-entry-name'}); const sup=attachManage(b,file); b.onclick=async()=>{if(sup())return;this.close();await this.app.workspace.getLeaf(false).openFile(file);}; });
  if (linked.length) { contentEl.createEl('h3',{text:"Entries from days",cls:'continuum-library-linked-title'}); const feature=this.plugin.getLibraryFeature(this.currentPath); const linkedList=contentEl.createDiv({cls:`continuum-library-linked-list${feature.checklistMode ? ' is-checklist' : ''}`}); linked.forEach(link=>{ const row=linkedList.createDiv({cls:`continuum-library-linked-row${link.checked?' is-checked':''}`}); if(feature.checklistMode){const c=row.createEl('input',{type:'checkbox'});c.checked=!!link.checked;c.onchange=async()=>{await this.plugin.setLibraryDailyLinkChecked(link.id,c.checked);this.render();};} const b=row.createEl('button',{cls:'continuum-library-linked-open'});b.createDiv({text:link.text||link.heading,cls:'continuum-library-linked-text'});if(!feature.checklistMode)b.createEl('small',{text:formatJournalDate((link.dailyPath.split('/').pop()||'').replace(/\.md$/,''))});b.createSpan({text:'↗',cls:'continuum-library-linked-arrow'});b.onclick=()=>this.plugin.openLibraryDailyLink(link); }); }
};

// Section actions: rename custom sections, configure knowledge bases, and close cleanly after archive.
SectionActionsModal.prototype.onOpen = function() {
  const { contentEl } = this; contentEl.addClass('continuum-section-actions-modal'); contentEl.createEl('h2',{text:`${this.section.emoji} ${this.section.name}`});
  if (this.section.source === 'custom') { const r=contentEl.createEl('button',{text:"✏️ Rename",cls:'continuum-secondary-action'}); r.onclick=()=>new ContinuumRenameModal(this.app,this.plugin,"Rename section",this.section.name,async value=>{await this.plugin.renameCustomSection(this.section,value);this.close();}).open(); }
  if (this.section.type === 'library') { const s=contentEl.createEl('button',{text:"⚙️ Section settings",cls:'continuum-secondary-action'}); s.onclick=()=>new ContinuumLibraryFolderSettingsModal(this.app,this.plugin,this.section.folder,this.section.name,()=>this.close()).open(); }
  const a=contentEl.createEl('button',{text:"📦 Move to archive",cls:'continuum-danger-action'}); a.onclick=async()=>{const ok=await this.plugin.archiveSection(this.section);if(ok){blurActiveEditable();this.close();window.setTimeout(()=>this.plugin.refreshSidebar(),0);}};
  contentEl.createEl('button',{text:"Cancel",cls:'continuum-secondary-action'}).onclick=()=>this.close();
};

module.exports = class ContinuumPlugin extends Plugin {
  async onload() {
    moment.locale('en');
    const data = await this.loadAndMigrateContinuumData();
    const raw = Array.isArray(data?.customSections) ? data.customSections : [];
    this.customSections = raw.map(section => ({
      ...section,
      type: section.type || 'journal',
      journal: section.journal || (section.type !== 'library' ? section.name : undefined),
      folder: section.folder || (section.type === 'library' ? `02 Knowledge/${section.name}` : undefined)
    }));
    this.hiddenBuiltins = Array.isArray(data?.hiddenBuiltins) ? data.hiddenBuiltins : [];
    this.archivedSections = Array.isArray(data?.archivedSections) ? data.archivedSections : [];
    this.relationshipSettings = {
      projectUrl: data?.relationshipSettings?.projectUrl || '',
      publishableKey: data?.relationshipSettings?.publishableKey || '',
      email: data?.relationshipSettings?.email || '',
      rememberSession: data?.relationshipSettings?.rememberSession === true
    };
    this.relationshipSession = null;
    this.sharedUnlockExpiresAt = Number(data?.sharedUnlockExpiresAt || 0);
    this.updateSettings = {
      autoCheck: data?.updateSettings?.autoCheck === true,
      lastCheckedAt: data?.updateSettings?.lastCheckedAt || null,
      channelId: sanitizeUpdateChannel(data?.updateSettings?.channelId)
    };
    this.onboardingCompleted = data?.onboardingCompleted === true;
    this.onboardingPromptDismissed = data?.onboardingPromptDismissed === true;

    this.registerView(VIEW_TYPE, leaf => new ContinuumSidebarView(leaf, this));
    this.addRibbonIcon('compass', "Open CONTINUUM", () => this.activateSidebar());
    this.addRibbonIcon('plus-circle', "CONTINUUM: add block", () => this.openChoice());

    this.addCommand({ id: 'continuum-open-sidebar', name: "Open CONTINUUM calendar and sections", callback: () => this.activateSidebar() });
    this.addCommand({ id: 'continuum-add-entry', name: "Add a block to today", callback: () => this.openChoice() });
    this.addCommand({ id: 'continuum-add-section', name: "Add a new section", callback: () => this.openAddSection() });
    this.addCommand({ id: 'continuum-open-today', name: "Open today's note", callback: () => this.openDate(moment()) });
    this.addCommand({ id: 'continuum-open-relationships', name: "Open the Relationships section", callback: () => this.openRelationships() });
    this.addCommand({ id: 'continuum-open-shared-calendar', name: "Open shared calendar", callback: () => this.openSharedCalendar() });
    this.addCommand({ id: 'continuum-setup-vault', name: "Check and set up the structure", callback: () => this.openInitialSetup(false) });
    this.addCommand({ id: 'continuum-create-support-report', name: "Create a safe support report", callback: () => this.createSupportReport() });
    this.addCommand({ id: 'continuum-restore-previous-version', name: "Restore previous CONTINUUM version", callback: () => this.restorePreviousContinuumVersion() });
    this.addSettingTab(new ContinuumSettingTab(this.app, this));

    this.registerMarkdownPostProcessor((element, context) => {
      if (!context.sourcePath.startsWith('01 Days/')) return;
      if (element.querySelector('.continuum-add-button')) return;
      const wrap = element.createDiv({ cls: 'continuum-add-wrap' });
      const button = wrap.createEl('button', { text: "＋ Add block", cls: 'continuum-add-button' });
      button.onclick = () => this.openChoice();
    });

    this.app.workspace.onLayoutReady(async () => {
      this.activateSidebar();
      if (!this.onboardingCompleted && !this.onboardingPromptDismissed) {
        await this.openInitialSetup(true);
      }
      if (this.updateSettings.autoCheck) {
        window.setTimeout(() => this.checkForContinuumUpdates({ openModal: false, silent: true }).catch(() => {}), 4000);
      }
    });
  }

  async onunload() { this.app.workspace.detachLeavesOfType(VIEW_TYPE); }

  async loadAndMigrateContinuumData() {
    const original = (await this.loadData()) || {};
    const data = { ...original };
    let version = Number.isInteger(data.schemaVersion) ? data.schemaVersion : 1;
    let changed = false;

    // v1 -> v2: normalize plugin-owned settings only.
    // IMPORTANT: migrations never rewrite Markdown notes, journal files,
    // attachments, folders or any other user content in the vault.
    if (version < 2) {
      if (!Array.isArray(data.customSections)) data.customSections = [];
      if (!Array.isArray(data.hiddenBuiltins)) data.hiddenBuiltins = [];
      if (!Array.isArray(data.archivedSections)) data.archivedSections = [];
      data.relationshipSettings = {
        projectUrl: data.relationshipSettings?.projectUrl || '',
        publishableKey: data.relationshipSettings?.publishableKey || '',
        email: data.relationshipSettings?.email || '',
        rememberSession: data.relationshipSettings?.rememberSession === true
      };
      version = 2;
      changed = true;
    }

    // v2 -> v3: updater preferences only. No Markdown/user files are touched.
    if (version < 3) {
      data.updateSettings = {
        autoCheck: data.updateSettings?.autoCheck === true,
        lastCheckedAt: data.updateSettings?.lastCheckedAt || null,
        channelId: sanitizeUpdateChannel(data.updateSettings?.channelId)
      };
      version = 3;
      changed = true;
    }

    // v3 -> v4: initialize optional knowledge-base state without importing content.
    if (version < 4) {
      if (!data.libraryFeatures || typeof data.libraryFeatures !== 'object' || Array.isArray(data.libraryFeatures)) data.libraryFeatures = {};
      if (!Array.isArray(data.libraryDailyLinks)) data.libraryDailyLinks = [];
      if (!Array.isArray(data.hiddenPrinciples)) data.hiddenPrinciples = [];
      delete data.librarySettings;
      version = 4;
      changed = true;
    }

    // v4 -> v5: normalize user-created names so visually identical paths remain identical.
    if (version < 5) {
      if (Array.isArray(data.customSections)) {
        data.customSections = data.customSections.map(section => {
          const name = String(section?.name || '').normalize('NFC');
          return {
            ...section,
            name,
            journal: section?.journal ? String(section.journal).normalize('NFC') : section?.journal,
            folder: section?.folder ? String(section.folder).normalize('NFC') : section?.folder
          };
        });
      }
      version = 5;
      changed = true;
    }

    // v5 -> v6: rename the optional rotating-message visibility state.
    // Existing text remains untouched and legacy principles stay readable.
    if (version < 6) {
      if (!Array.isArray(data.hiddenMotivations)) {
        data.hiddenMotivations = Array.isArray(data.hiddenPrinciples) ? [...data.hiddenPrinciples] : [];
      }
      delete data.hiddenPrinciples;
      version = 6;
      changed = true;
    }

    // v6 -> v7: mark settings as safe for Obsidian Sync-aware reloads.
    // Notes and attachments remain regular files in the vault. No user content
    // is moved or uploaded by this migration.
    if (version < 7) {
      data.syncCompatibilityVersion = 1;
      version = 7;
      changed = true;
    }

    // v7 -> v8: first-run state only. Existing folders and user files are
    // inspected but never renamed, moved or overwritten by this migration.
    if (version < 8) {
      data.onboardingCompleted = data.onboardingCompleted === true;
      data.onboardingPromptDismissed = data.onboardingPromptDismissed === true;
      version = 8;
      changed = true;
    }

    if (data.schemaVersion !== version) {
      data.schemaVersion = version;
      changed = true;
    }
    if (data.lastPluginVersion !== CONTINUUM_PLUGIN_VERSION) {
      data.lastPluginVersion = CONTINUUM_PLUGIN_VERSION;
      changed = true;
    }

    this.dataSchemaVersion = version;
    if (changed) await this.saveData(data);
    return data;
  }

  async getMotivations(options = {}) {
    const results = [];
    const seen = new Set();
    const add = value => {
      const text = String(value || '').replace(/^[-*\s]+/, '').replace(/^>\s*/, '').trim();
      if (!text || text.length < 3 || seen.has(text)) return;
      seen.add(text);
      results.push(text);
    };

    // New entries are stored in a simple local Markdown file.
    const motivationFile = this.app.vault.getAbstractFileByPath('Motivation.md');
    if (motivationFile && motivationFile.extension === 'md') {
      try {
        const content = await this.app.vault.cachedRead(motivationFile);
        content.split('\n').forEach(line => {
          if (/^>\s+/.test(line.trim())) add(line.trim());
        });
      } catch (e) { console.error('CONTINUUM: cannot read motivation file', e); }
    }

    // Keep older personal phrases readable after updating an existing vault.
    const constitution = this.app.vault.getAbstractFileByPath('CONTINUUM Constitution.md');
    if (constitution && constitution.extension === 'md') {
      try {
        const content = await this.app.vault.cachedRead(constitution);
        const markers = ['## My principles', '## My first principles'];
        const marker = markers.find(candidate => content.includes(candidate));
        const start = marker ? content.indexOf(marker) : -1;
        if (start >= 0) {
          const remainder = content.slice(start + marker.length);
          const nextHeading = remainder.search(/\n##\s+/);
          const section = nextHeading >= 0 ? remainder.slice(0, nextHeading) : remainder;
          section.split('\n').forEach(line => {
            if (/^>\s+/.test(line.trim())) add(line.trim());
          });
        }
      } catch (e) { console.error('CONTINUUM: cannot read legacy motivation entries', e); }
    }

    // Legacy and optional daily motivation blocks are also supported.
    const dailyFiles = this.app.vault.getMarkdownFiles().filter(file => file.path.startsWith('01 Days/'));
    for (const file of dailyFiles) {
      try {
        const content = await this.app.vault.read(file);
        const lines = content.split('\n');
        let collecting = false;
        let buffer = [];
        const flush = () => {
          if (!buffer.length) return;
          const text = buffer.join(' ').replace(/\s+/g, ' ').trim();
          add(text);
          buffer = [];
        };
        for (const line of lines) {
          if (/^##\s+(?:✨\s*Motivation|🧭\s*Principle)\s*$/.test(line.trim())) {
            flush();
            collecting = true;
            continue;
          }
          if (collecting && /^#{1,6}\s+/.test(line.trim())) {
            flush();
            collecting = false;
            continue;
          }
          if (collecting && line.trim()) buffer.push(line.trim());
        }
        flush();
      } catch (e) { console.error('CONTINUUM: cannot read daily motivation', file.path, e); }
    }

    if (options.includeHidden) return results;
    const hidden = new Set(this.hiddenMotivations || []);
    return results.filter(text => !hidden.has(text));
  }

  async ensureMotivationFile() {
    let file = this.app.vault.getAbstractFileByPath('Motivation.md');
    if (!file) file = await this.app.vault.create('Motivation.md', '# Motivation\n\n');
    return file;
  }

  async addMotivation(value) {
    const clean = String(value || '')
      .replace(/^>\s*/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1000);
    if (clean.length < 3) {
      new Notice("Enter the motivation text");
      return false;
    }

    const existing = await this.getMotivations({ includeHidden: true });
    if (existing.includes(clean)) {
      await this.setMotivationVisible(clean, true);
      this.refreshSidebar();
      new Notice("This motivation is already saved");
      return true;
    }

    const file = await this.ensureMotivationFile();
    await this.app.vault.append(file, `> ${clean}\n\n`);
    await this.setMotivationVisible(clean, true);
    this.refreshSidebar();
    new Notice("Motivation added");
    return true;
  }

  getCustomJournals() { return this.customSections.filter(section => section.type === 'journal'); }
  getCustomLibraries() { return this.customSections.filter(section => section.type === 'library'); }
  isBuiltinHidden(id) { return this.hiddenBuiltins.includes(id); }

  getAllTypes() {
    const builtins = BUILTIN_TYPES.filter(type => !type.journal || !this.isBuiltinHidden(`journal:${type.journal}`));
    const custom = this.getCustomJournals().map(section => ({
      key: `custom-${section.journal}`,
      label: `${section.emoji} ${section.name}`,
      journal: section.journal
    }));
    return [...builtins, ...custom];
  }

  async saveContinuumData() {
    const current = (await this.loadData()) || {};
    await this.saveData({
      ...current,
      schemaVersion: this.dataSchemaVersion || CONTINUUM_DATA_SCHEMA_VERSION,
      lastPluginVersion: CONTINUUM_PLUGIN_VERSION,
      customSections: this.customSections,
      hiddenBuiltins: this.hiddenBuiltins,
      archivedSections: this.archivedSections,
      relationshipSettings: this.relationshipSettings,
      sharedUnlockExpiresAt: Number(this.sharedUnlockExpiresAt || 0),
      updateSettings: this.updateSettings || { autoCheck: false, lastCheckedAt: null }
      ,onboardingCompleted: this.onboardingCompleted === true
      ,onboardingPromptDismissed: this.onboardingPromptDismissed === true
    });
  }

  async getInitialSetupPlan() {
    const adapter = this.app.vault.adapter;
    const folders = [];
    const files = [];
    for (const path of CONTINUUM_INITIAL_FOLDERS) {
      if (!(await adapter.exists(path))) folders.push(path);
    }
    for (const path of Object.keys(CONTINUUM_INITIAL_FILES)) {
      if (!(await adapter.exists(path))) files.push(path);
    }
    return { folders, files };
  }

  async openInitialSetup(automatic = false) {
    const plan = await this.getInitialSetupPlan();
    if (automatic && !plan.folders.length && !plan.files.length) {
      this.onboardingCompleted = true;
      await this.saveContinuumData();
      return;
    }
    new ContinuumFirstRunModal(this.app, this, plan, automatic).open();
  }

  async installInitialStructure(plan) {
    const adapter = this.app.vault.adapter;
    for (const path of CONTINUUM_INITIAL_FOLDERS) {
      if (!(await adapter.exists(path))) await this.ensureFolder(path);
    }
    for (const path of plan.files) {
      if (await adapter.exists(path)) continue;
      const parent = path.includes('/') ? path.split('/').slice(0, -1).join('/') : '';
      if (parent) await this.ensureFolder(parent);
      await this.app.vault.create(path, CONTINUUM_INITIAL_FILES[path]);
    }
    this.onboardingCompleted = true;
    this.onboardingPromptDismissed = false;
    await this.saveContinuumData();
  }

  async openHomePage() {
    const file = this.app.vault.getAbstractFileByPath('Home.md');
    if (file) await this.app.workspace.getLeaf(false).openFile(file);
  }

  async createSupportReport() {
    const vault = this.app.vault;
    const files = typeof vault.getFiles === 'function' ? vault.getFiles() : [];
    const markdownCount = typeof vault.getMarkdownFiles === 'function' ? vault.getMarkdownFiles().length : 0;
    const attachmentCount = files.filter(file => file.extension && file.extension !== 'md').length;
    const report = [
      "# CONTINUUM safe support report",
      '',
      "> This report contains no note texts, personal file names, attachments, passwords, keys or \"Together\" content.",
      '',
      `- CONTINUUM: ${CONTINUUM_PLUGIN_VERSION}`,
      `- Data schema: ${this.dataSchemaVersion || CONTINUUM_DATA_SCHEMA_VERSION}`,
      `- Obsidian: ${this.app.version || "unknown"}`,
      `- Platform: ${typeof navigator !== 'undefined' ? navigator.platform || navigator.userAgent || "unknown" : "unknown"}`,
      `- Markdown files: ${markdownCount}`,
      `- Attachments: ${attachmentCount}`,
      `- Personal sections: ${this.getCustomJournals().length}`,
      `- "Projects & knowledge" sections: ${this.getCustomLibraries().length}`,
      `- "Together" configured: ${this.relationshipConfigured() ? "yes" : "no"}`,
      `- Created: ${moment().format('DD.MM.YYYY HH:mm')}`,
      ''
    ].join('\n');
    const folder = '05 Archive/CONTINUUM Reports';
    await this.ensureFolder(folder);
    const path = `${folder}/Diagnostics ${moment().format('YYYY-MM-DD_HHmmss')}.md`;
    const created = await vault.create(path, report);
    new Notice("Safe report created");
    await this.app.workspace.getLeaf(false).openFile(created);
  }


  async fetchManifestFrom(manifestUrl) {
    const response = await requestUrl({ url: manifestUrl, method: 'GET' });
    const manifest = response.json || JSON.parse(response.text || '{}');
    if (!manifest || typeof manifest !== 'object') throw new Error("Invalid update file");
    if (!/^\d+\.\d+\.\d+$/.test(String(manifest.version || ''))) throw new Error("Invalid update version");
    if (!Array.isArray(manifest.files) || manifest.files.length !== 3) throw new Error("Incomplete update package");
    const names = manifest.files.map(f => f.path).sort();
    if (names.join('|') !== [...CONTINUUM_UPDATE_ALLOWED_FILES].sort().join('|')) throw new Error("The package contains invalid system files");
    for (const file of manifest.files) {
      if (!file.url || !/^[a-f0-9]{64}$/i.test(String(file.sha256 || ''))) throw new Error(`No checksum for ${file.path}`);
      if (!String(file.url).startsWith(CONTINUUM_UPDATE_FILE_PREFIX)) throw new Error(`Invalid update source: ${file.path}`);
    }
    return manifest;
  }

  // General updates live in the repository root; personal ones in channels/<name>/.
  // The newer version wins; on a tie the personal package is used.
  async fetchUpdateManifest() {
    const channel = sanitizeUpdateChannel(this.updateSettings?.channelId);
    let general = null;
    let generalError = null;
    try { general = await this.fetchManifestFrom(`${CONTINUUM_UPDATE_FILE_PREFIX}main/latest.json`); }
    catch (e) { generalError = e; }
    let personal = null;
    if (channel) {
      try { personal = await this.fetchManifestFrom(`${CONTINUUM_UPDATE_FILE_PREFIX}main/channels/${channel}/latest.json`); }
      catch (e) { personal = null; }
    }
    if (general && personal) return compareVersions(personal.version, general.version) >= 0 ? personal : general;
    if (personal) return personal;
    if (general) return general;
    throw generalError || new Error("Invalid update file");
  }

  async checkForContinuumUpdates({ openModal = true, silent = false } = {}) {
    try {
      const manifest = await this.fetchUpdateManifest();
      this.updateSettings.lastCheckedAt = new Date().toISOString();
      await this.saveContinuumData();
      if (compareVersions(manifest.version, CONTINUUM_PLUGIN_VERSION) <= 0) {
        if (!silent) new Notice(`CONTINUUM ${CONTINUUM_PLUGIN_VERSION}: no updates`);
        return null;
      }
      if (openModal) new ContinuumUpdateModal(this.app, this, manifest).open();
      else new Notice(`CONTINUUM update ${manifest.version} is available`);
      return manifest;
    } catch (e) {
      if (!silent) new Notice(`Could not check for updates: ${e.message || e}`);
      throw e;
    }
  }

  async createSystemBackup() {
    const adapter = this.app.vault.adapter;
    const stamp = moment().format('YYYY-MM-DD_HHmmss');
    const backupRoot = `05 Archive/CONTINUUM Backups/${stamp}`;
    await this.ensureFolder('05 Archive/CONTINUUM Backups');
    await this.ensureFolder(backupRoot);
    const pluginRoot = `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    for (const name of CONTINUUM_UPDATE_ALLOWED_FILES) {
      const source = `${pluginRoot}/${name}`;
      if (await adapter.exists(source)) {
        const content = await adapter.read(source);
        await adapter.write(`${backupRoot}/${name}`, content);
      }
    }
    await this.app.vault.adapter.write(`${backupRoot}/README.txt`, `Backup of CONTINUUM system files only, made before updating from version ${CONTINUUM_PLUGIN_VERSION}. data.json, notes, journals, attachments and shared-space data were not copied.
`);
    return backupRoot;
  }

  async installContinuumUpdate(manifest, createBackup) {
    if (manifest.touchesUserData) throw new Error("Auto-update stopped: the package affects user data");
    if (manifest.requiresSupabaseMigration) throw new Error("The administrator must update the shared space first");
    const adapter = this.app.vault.adapter;
    const pluginRoot = `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    const downloaded = {};

    // 1. Download and verify everything before touching installed files.
    for (const item of manifest.files) {
      const response = await requestUrl({ url: item.url, method: 'GET' });
      const text = response.text;
      const hash = await sha256Text(text);
      if (hash.toLowerCase() !== String(item.sha256).toLowerCase()) throw new Error(`Integrity check failed: ${item.path}`);
      downloaded[item.path] = text;
    }
    const nextManifest = JSON.parse(downloaded['manifest.json']);
    if (nextManifest.id !== this.manifest.id || nextManifest.version !== manifest.version) throw new Error("manifest.json does not match the update package");

    if (createBackup) {
      const backup = await this.createSystemBackup();
      new Notice(`Backup: ${backup}`);
    }

    // 2. Stage all files.
    for (const name of CONTINUUM_UPDATE_ALLOWED_FILES) await adapter.write(`${pluginRoot}/${name}.next`, downloaded[name]);

    // 3. Atomic-ish swap with rollback copies.
    const swapped = [];
    try {
      for (const name of CONTINUUM_UPDATE_ALLOWED_FILES) {
        const current = `${pluginRoot}/${name}`;
        const previous = `${pluginRoot}/${name}.prev`;
        const next = `${pluginRoot}/${name}.next`;
        if (await adapter.exists(previous)) await adapter.remove(previous);
        if (await adapter.exists(current)) await adapter.rename(current, previous);
        await adapter.rename(next, current);
        swapped.push(name);
      }
      // Keep one verified previous system version for an explicit rollback.
      // These files contain plugin code/styles only, never user notes or data.json.
    } catch (e) {
      for (const name of [...swapped].reverse()) {
        const current = `${pluginRoot}/${name}`;
        const previous = `${pluginRoot}/${name}.prev`;
        try {
          if (await adapter.exists(current)) await adapter.remove(current);
          if (await adapter.exists(previous)) await adapter.rename(previous, current);
        } catch (_) {}
      }
      for (const name of CONTINUUM_UPDATE_ALLOWED_FILES) {
        const next = `${pluginRoot}/${name}.next`;
        try { if (await adapter.exists(next)) await adapter.remove(next); } catch (_) {}
      }
      throw e;
    }
    new Notice(`CONTINUUM ${manifest.version} installed. Fully restart Obsidian.`);
  }

  async restorePreviousContinuumVersion() {
    const adapter = this.app.vault.adapter;
    const pluginRoot = `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    for (const name of CONTINUUM_UPDATE_ALLOWED_FILES) {
      if (!(await adapter.exists(`${pluginRoot}/${name}.prev`))) {
        new Notice("No previous system version found");
        return false;
      }
    }
    if (!window.confirm("Restore the previous CONTINUUM system version? Your personal notes will not change.")) return false;
    const moved = [];
    try {
      for (const name of CONTINUUM_UPDATE_ALLOWED_FILES) {
        const current = `${pluginRoot}/${name}`;
        const previous = `${pluginRoot}/${name}.prev`;
        const failed = `${pluginRoot}/${name}.failed`;
        if (await adapter.exists(failed)) await adapter.remove(failed);
        if (await adapter.exists(current)) await adapter.rename(current, failed);
        await adapter.rename(previous, current);
        moved.push(name);
      }
      new Notice("The previous version has been restored. Fully restart Obsidian.");
      return true;
    } catch (e) {
      for (const name of [...moved].reverse()) {
        const current = `${pluginRoot}/${name}`;
        const failed = `${pluginRoot}/${name}.failed`;
        try {
          if (await adapter.exists(current)) await adapter.rename(current, `${pluginRoot}/${name}.prev`);
          if (await adapter.exists(failed)) await adapter.rename(failed, current);
        } catch (_) {}
      }
      throw e;
    }
  }

  async migrateJournalDateAliases() {
    const files = this.app.vault.getMarkdownFiles().filter(file => file.path.startsWith('03 Journals/'));
    let changedFiles = 0;
    const pattern = /\[\[([^\]|]+)#([^\]|]+)\|(\d{4})-(\d{2})-(\d{2})(\s+—\s+[^\]]+)\]\]/g;
    for (const file of files) {
      const original = await this.app.vault.read(file);
      const updated = original.replace(pattern, (full, target, heading, y, m, d, rest) => `[[${target}#${heading}|${d}.${m}.${y}${rest}]]`);
      if (updated !== original) {
        await this.app.vault.modify(file, updated);
        changedFiles += 1;
      }
    }
    return changedFiles;
  }


  relationshipConfigured() {
    const s = this.relationshipSettings || {};
    return /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(String(s.projectUrl || '')) &&
      /^sb_publishable_[A-Za-z0-9_-]+$/.test(String(s.publishableKey || '')) &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s.email || ''));
  }

  sharedSessionIsUnlocked() {
    return Boolean(
      this.relationshipSession?.accessToken &&
      this.relationshipSession?.encryptionSecret &&
      Date.now() < Number(this.sharedUnlockExpiresAt || 0)
    );
  }

  async clearSharedSessionCache() {
    this.relationshipSession = null;
    this.sharedUnlockExpiresAt = 0;
    try {
      if (this.app?.secretStorage?.setSecret) {
        await Promise.resolve(this.app.secretStorage.setSecret(CONTINUUM_SHARED_SESSION_SECRET_ID, ''));
      }
    } catch (e) {
      console.warn('CONTINUUM: cannot clear shared session secret', e);
    }
    await this.saveContinuumData().catch(() => {});
  }

  async endRelationshipSession() {
    const accessToken = this.relationshipSession?.accessToken;
    if (accessToken && this.relationshipConfigured()) {
      try {
        await this.supabaseRequest('/auth/v1/logout?scope=local', { method: 'POST' });
      } catch (e) {
        // Local cleanup must still happen if the device is offline or the token already expired.
        console.warn('CONTINUUM: remote logout was unavailable', e);
      }
    }
    await this.clearSharedSessionCache();
  }

  async saveSharedSessionCache(refreshToken, encryptionSecret) {
    if (!refreshToken || !encryptionSecret) return;
    try {
      if (!this.app?.secretStorage?.setSecret) return;
      await Promise.resolve(this.app.secretStorage.setSecret(
        CONTINUUM_SHARED_SESSION_SECRET_ID,
        JSON.stringify({
          refreshToken,
          encryptionSecret
        })
      ));
    } catch (e) {
      console.warn('CONTINUUM: cannot persist shared session secret', e);
    }
  }

  getSharedSessionCache() {
    try {
      if (!this.app?.secretStorage?.getSecret) return null;
      const raw = this.app.secretStorage.getSecret(CONTINUUM_SHARED_SESSION_SECRET_ID);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed?.refreshToken || !parsed?.encryptionSecret) return null;
      return parsed;
    } catch (e) {
      console.warn('CONTINUUM: cannot read shared session secret', e);
      return null;
    }
  }

  async restoreSharedSessionFromCache() {
    const expiresAt = Number(this.sharedUnlockExpiresAt || 0);
    if (!expiresAt || Date.now() >= expiresAt) {
      await this.clearSharedSessionCache();
      return false;
    }

    const cached = this.getSharedSessionCache();
    if (!cached) return false;

    try {
      const auth = await this.supabaseRequest('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        body: JSON.stringify({ refresh_token: cached.refreshToken })
      }, false);

      if (!auth?.access_token || !auth?.user?.id) throw new Error("Could not restore the session");

      this.relationshipSession = {
        accessToken: auth.access_token,
        refreshToken: auth.refresh_token || cached.refreshToken,
        user: auth.user,
        encryptionSecret: cached.encryptionSecret
      };

      const memberships = await this.supabaseRequest(
        `/rest/v1/space_members?select=space_id,user_id&user_id=eq.${encodeURIComponent(auth.user.id)}`
      );
      if (!Array.isArray(memberships) || !memberships.length) {
        throw new Error("The user has not been added to the shared space");
      }

      this.relationshipSession.spaceId = memberships[0].space_id;

      // Supabase rotates refresh tokens. Store the newest token without
      // extending the original 12-hour CONTINUUM unlock window.
      await this.saveSharedSessionCache(
        this.relationshipSession.refreshToken,
        cached.encryptionSecret
      );
      return true;
    } catch (e) {
      console.warn('CONTINUUM: shared session restore failed', e);
      await this.clearSharedSessionCache();
      return false;
    }
  }

  async ensureSharedSession(onReady) {
    if (!this.relationshipConfigured()) {
      new Notice("The \"Together\" section is not connected yet. Contact the CONTINUUM administrator");
      return;
    }

    if (this.sharedSessionIsUnlocked()) {
      onReady();
      return;
    }

    if (Date.now() < Number(this.sharedUnlockExpiresAt || 0)) {
      const restored = await this.restoreSharedSessionFromCache();
      if (restored) {
        onReady();
        return;
      }
    }

    this.relationshipSession = null;
    if (Date.now() >= Number(this.sharedUnlockExpiresAt || 0)) {
      await this.clearSharedSessionCache();
    }
    new RelationshipSessionModal(this.app, this, onReady).open();
  }

  async openRelationships() {
    await this.ensureSharedSession(() => new RelationshipsModal(this.app, this).open());
  }

  async openSharedCalendar() {
    await this.ensureSharedSession(() => new SharedCalendarModal(this.app, this).open());
  }

  async supabaseRequest(path, options = {}, authenticated = true) {
    if (!this.relationshipConfigured()) throw new Error("The \"Together\" section has not been connected by the administrator");
    const url = `${this.relationshipSettings.projectUrl}${path}`;
    const headers = Object.assign({
      'apikey': this.relationshipSettings.publishableKey,
      'Content-Type': 'application/json'
    }, options.headers || {});
    if (authenticated) {
      if (!this.relationshipSession?.accessToken) throw new Error("No session is open");
      headers.Authorization = `Bearer ${this.relationshipSession.accessToken}`;
    }
    const response = await fetch(url, { ...options, headers });
    const text = await response.text();
    let body = null;
    if (text) {
      try { body = JSON.parse(text); } catch (_) { body = text; }
    }
    if (!response.ok) {
      const message = body?.msg || body?.message || body?.error_description || body?.error || `${response.status} ${response.statusText}`;
      throw new Error(message);
    }
    return body;
  }

  async startRelationshipSession(password, encryptionSecret) {
    const auth = await this.supabaseRequest('/auth/v1/token?grant_type=password', {
      method: 'POST',
      body: JSON.stringify({ email: this.relationshipSettings.email, password })
    }, false);
    if (!auth?.access_token || !auth?.user?.id) throw new Error("Could not open the user session");
    const session = {
      accessToken: auth.access_token,
      refreshToken: auth.refresh_token || null,
      user: auth.user,
      encryptionSecret
    };
    this.relationshipSession = session;
    const memberships = await this.supabaseRequest(`/rest/v1/space_members?select=space_id,user_id&user_id=eq.${encodeURIComponent(auth.user.id)}`);
    if (!Array.isArray(memberships) || !memberships.length) {
      this.relationshipSession = null;
      throw new Error("The user has not been added to the shared space");
    }
    this.relationshipSession.spaceId = memberships[0].space_id;
    this.sharedUnlockExpiresAt = Date.now() + (12 * 60 * 60 * 1000);
    if (this.relationshipSettings.rememberSession) {
      await this.saveSharedSessionCache(this.relationshipSession.refreshToken, encryptionSecret);
    }
    await this.saveContinuumData();
  }

  async deriveRelationshipKey(secret, salt) {
    if (!window.crypto?.subtle) throw new Error("Web Crypto is not available on this device");
    const material = await window.crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveKey']
    );
    return window.crypto.subtle.deriveKey({
      name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256'
    }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  async encryptRelationshipText(text) {
    const salt = window.crypto.getRandomValues(new Uint8Array(16));
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const key = await this.deriveRelationshipKey(this.relationshipSession.encryptionSecret, salt);
    const encrypted = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
    return {
      encrypted_content: bytesToBase64(new Uint8Array(encrypted)),
      encryption_iv: `${bytesToBase64(salt)}.${bytesToBase64(iv)}`
    };
  }

  async decryptRelationshipText(entry) {
    const [saltB64, ivB64] = String(entry.encryption_iv || '').split('.');
    if (!saltB64 || !ivB64) throw new Error("Invalid encryption parameters");
    const salt = base64ToBytes(saltB64);
    const iv = base64ToBytes(ivB64);
    const key = await this.deriveRelationshipKey(this.relationshipSession.encryptionSecret, salt);
    const plain = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, base64ToBytes(entry.encrypted_content));
    return new TextDecoder().decode(plain);
  }

  async encodeRelationshipTitle(title) {
    const encrypted = await this.encryptRelationshipText(String(title || '').trim());
    return `enc1:${encrypted.encryption_iv}:${encrypted.encrypted_content}`;
  }

  async decodeRelationshipTitle(value, situation = null) {
    const raw = String(value || '');
    if (!raw) return situation ? `Topic from ${moment(situation.created_at).format('DD.MM.YYYY')}` : '';
    if (!raw.startsWith('enc1:')) return raw;
    const rest = raw.slice(5);
    const idx = rest.indexOf(':');
    if (idx < 0) return "Encrypted topic";
    try {
      return await this.decryptRelationshipText({ encryption_iv: rest.slice(0, idx), encrypted_content: rest.slice(idx + 1) });
    } catch (_) { return "Encrypted topic"; }
  }

  async createRelationshipSituation(title, text) {
    const session = this.relationshipSession;
    if (!session?.spaceId) throw new Error("No active space");
    const encryptedTitle = await this.encodeRelationshipTitle(title);
    const situations = await this.supabaseRequest('/rest/v1/situations?select=id,space_id,created_by,title,status,created_at,updated_at,close_requested_by,close_requested_at,closed_at', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ space_id: session.spaceId, created_by: session.user.id, title: encryptedTitle })
    });
    const situation = Array.isArray(situations) ? situations[0] : null;
    if (!situation?.id) throw new Error("Could not create the topic");
    const encrypted = await this.encryptRelationshipText(text);
    await this.supabaseRequest('/rest/v1/entries', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        situation_id: situation.id,
        author_id: session.user.id,
        encrypted_content: encrypted.encrypted_content,
        encryption_iv: encrypted.encryption_iv,
        is_finished: true
      })
    });
    this.sendRelationshipEmailNotification('new_topic', situation.id).catch(e => console.warn('Continuum email notification', e));
    return situation;
  }

  async addRelationshipEntry(situationId, text) {
    const session = this.relationshipSession;
    if (!session?.user?.id) throw new Error("No active session");
    const encrypted = await this.encryptRelationshipText(text);
    await this.supabaseRequest('/rest/v1/entries', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        situation_id: situationId,
        author_id: session.user.id,
        encrypted_content: encrypted.encrypted_content,
        encryption_iv: encrypted.encryption_iv,
        is_finished: true
      })
    });
    this.sendRelationshipEmailNotification('initial_response', situationId).catch(e => console.warn('Continuum email notification', e));
  }

  async getRelationshipSituations() {
    const spaceId = this.relationshipSession?.spaceId;
    if (!spaceId) return [];
    const fields = 'id,space_id,created_by,title,status,created_at,updated_at,close_requested_by,close_requested_at,closed_at';
    const rows = await this.supabaseRequest(`/rest/v1/situations?select=${fields}&space_id=eq.${encodeURIComponent(spaceId)}&order=updated_at.desc`);
    return Array.isArray(rows) ? rows : [];
  }

  async getRelationshipSituation(situationId) {
    const fields = 'id,space_id,created_by,title,status,created_at,updated_at,close_requested_by,close_requested_at,closed_at';
    const rows = await this.supabaseRequest(`/rest/v1/situations?select=${fields}&id=eq.${encodeURIComponent(situationId)}&limit=1`);
    return Array.isArray(rows) ? rows[0] || null : null;
  }

  async getRelationshipEntries(situationId) {
    const rows = await this.supabaseRequest(`/rest/v1/entries?select=id,situation_id,author_id,encrypted_content,encryption_iv,is_finished,created_at,finished_at,updated_at&situation_id=eq.${encodeURIComponent(situationId)}&order=created_at.asc`);
    return Array.isArray(rows) ? rows : [];
  }

  async getRelationshipMessages(situationId) {
    const rows = await this.supabaseRequest(`/rest/v1/relationship_messages?select=id,situation_id,author_id,encrypted_content,encryption_iv,created_at,updated_at&situation_id=eq.${encodeURIComponent(situationId)}&order=created_at.asc`);
    return Array.isArray(rows) ? rows : [];
  }

  async addRelationshipMessage(situationId, text) {
    const encrypted = await this.encryptRelationshipText(text);
    await this.supabaseRequest('/rest/v1/relationship_messages', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        situation_id: situationId,
        author_id: this.relationshipSession.user.id,
        encrypted_content: encrypted.encrypted_content,
        encryption_iv: encrypted.encryption_iv
      })
    });
    this.sendRelationshipEmailNotification('new_message', situationId).catch(e => console.warn('Continuum email notification', e));
  }

  async updateRelationshipEntry(entryId, text) {
    throw new Error("A published initial position cannot be changed");
  }

  async updateRelationshipMessage(messageId, text) {
    const session = this.relationshipSession;
    if (!session?.user?.id) throw new Error("No active session");
    const value = String(text || '').trim();
    if (!value) throw new Error("The comment cannot be empty");
    const encrypted = await this.encryptRelationshipText(value);
    await this.supabaseRequest(`/rest/v1/relationship_messages?id=eq.${encodeURIComponent(messageId)}&author_id=eq.${encodeURIComponent(session.user.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        encrypted_content: encrypted.encrypted_content,
        encryption_iv: encrypted.encryption_iv,
        updated_at: new Date().toISOString()
      })
    });
  }

  async getRelationshipEntryVersions(entryId) {
    const rows = await this.supabaseRequest(`/rest/v1/entry_versions?select=id,entry_id,version_number,encrypted_content,encryption_iv,changed_at&entry_id=eq.${encodeURIComponent(entryId)}&order=version_number.desc`);
    return Array.isArray(rows) ? rows : [];
  }

  async getRelationshipMessageVersions(messageId) {
    const rows = await this.supabaseRequest(`/rest/v1/relationship_message_versions?select=id,message_id,version_number,encrypted_content,encryption_iv,changed_at&message_id=eq.${encodeURIComponent(messageId)}&order=version_number.desc`);
    return Array.isArray(rows) ? rows : [];
  }

  async getRelationshipPreferences() {
    const spaceId = this.relationshipSession?.spaceId;
    if (!spaceId) return [];
    const rows = await this.supabaseRequest(`/rest/v1/relationship_member_preferences?select=space_id,user_id,accent_color,email_notifications_enabled,updated_at&space_id=eq.${encodeURIComponent(spaceId)}`);
    return Array.isArray(rows) ? rows : [];
  }

  async getMyRelationshipColor() {
    const prefs = await this.getRelationshipPreferences().catch(() => []);
    return prefs.find(p => p.user_id === this.relationshipSession?.user?.id)?.accent_color || 'blue';
  }

  async getPartnerRelationshipColor() {
    const prefs = await this.getRelationshipPreferences().catch(() => []);
    return prefs.find(p => p.user_id !== this.relationshipSession?.user?.id)?.accent_color || 'green';
  }

  async setRelationshipAccentColor(color) {
    if (!['blue', 'green', 'purple', 'orange'].includes(color)) throw new Error("Invalid color");
    const spaceId = this.relationshipSession?.spaceId;
    const userId = this.relationshipSession?.user?.id;
    if (!spaceId || !userId) throw new Error("No active session");
    const existing = await this.supabaseRequest(`/rest/v1/relationship_member_preferences?select=space_id,user_id&space_id=eq.${encodeURIComponent(spaceId)}&user_id=eq.${encodeURIComponent(userId)}&limit=1`);
    if (Array.isArray(existing) && existing.length) {
      await this.supabaseRequest(`/rest/v1/relationship_member_preferences?space_id=eq.${encodeURIComponent(spaceId)}&user_id=eq.${encodeURIComponent(userId)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ accent_color: color, updated_at: new Date().toISOString() })
      });
    } else {
      await this.supabaseRequest('/rest/v1/relationship_member_preferences', {
        method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ space_id: spaceId, user_id: userId, accent_color: color })
      });
    }
  }

  async setRelationshipEmailNotificationsEnabled(enabled) {
    const spaceId = this.relationshipSession?.spaceId;
    const userId = this.relationshipSession?.user?.id;
    if (!spaceId || !userId) throw new Error("No active session");
    const existing = await this.supabaseRequest(`/rest/v1/relationship_member_preferences?select=space_id,user_id&space_id=eq.${encodeURIComponent(spaceId)}&user_id=eq.${encodeURIComponent(userId)}&limit=1`);
    if (Array.isArray(existing) && existing.length) {
      await this.supabaseRequest(`/rest/v1/relationship_member_preferences?space_id=eq.${encodeURIComponent(spaceId)}&user_id=eq.${encodeURIComponent(userId)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ email_notifications_enabled: Boolean(enabled), updated_at: new Date().toISOString() })
      });
    } else {
      await this.supabaseRequest('/rest/v1/relationship_member_preferences', {
        method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ space_id: spaceId, user_id: userId, accent_color: 'blue', email_notifications_enabled: Boolean(enabled) })
      });
    }
  }

  async sendRelationshipEmailNotification(eventType, situationId) {
    if (!this.relationshipSession?.accessToken) return;
    const allowed = ['new_topic', 'initial_response', 'new_message', 'close_request'];
    if (!allowed.includes(eventType)) return;
    try {
      await this.supabaseRequest('/functions/v1/relationship-email', {
        method: 'POST',
        body: JSON.stringify({ event_type: eventType, situation_id: situationId })
      });
    } catch (e) {
      // Email is intentionally non-blocking: a mail outage must never prevent the conversation itself.
      console.warn('Continuum relationship email unavailable', e);
    }
  }

  async getSharedCalendarItems(dateFrom, dateTo) {
    const spaceId = this.relationshipSession?.spaceId;
    if (!spaceId) throw new Error("No active shared space");
    const fields = 'id,space_id,calendar_date,created_by,encrypted_content,encryption_iv,is_completed,created_at,updated_at';
    const path = `/rest/v1/shared_calendar_items?select=${fields}&space_id=eq.${encodeURIComponent(spaceId)}&calendar_date=gte.${encodeURIComponent(dateFrom)}&calendar_date=lte.${encodeURIComponent(dateTo)}&order=calendar_date.asc,created_at.asc`;
    const rows = await this.supabaseRequest(path);
    return Array.isArray(rows) ? rows : [];
  }

  async addSharedCalendarItem(dateString, text) {
    const session = this.relationshipSession;
    if (!session?.spaceId || !session?.user?.id) throw new Error("No active shared space");
    const encrypted = await this.encryptRelationshipText(text);
    await this.supabaseRequest('/rest/v1/shared_calendar_items', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        space_id: session.spaceId,
        calendar_date: dateString,
        created_by: session.user.id,
        encrypted_content: encrypted.encrypted_content,
        encryption_iv: encrypted.encryption_iv,
        is_completed: false
      })
    });
  }

  async updateSharedCalendarItem(itemId, text) {
    const encrypted = await this.encryptRelationshipText(text);
    await this.supabaseRequest(`/rest/v1/shared_calendar_items?id=eq.${encodeURIComponent(itemId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        encrypted_content: encrypted.encrypted_content,
        encryption_iv: encrypted.encryption_iv,
        updated_at: new Date().toISOString()
      })
    });
  }

  async setSharedCalendarItemCompleted(itemId, completed) {
    await this.supabaseRequest(`/rest/v1/shared_calendar_items?id=eq.${encodeURIComponent(itemId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ is_completed: Boolean(completed), updated_at: new Date().toISOString() })
    });
  }

  async deleteSharedCalendarItem(itemId) {
    await this.supabaseRequest(`/rest/v1/shared_calendar_items?id=eq.${encodeURIComponent(itemId)}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' }
    });
  }

  async relationshipRpc(name, args) {
    return this.supabaseRequest(`/rest/v1/rpc/${name}`, { method: 'POST', body: JSON.stringify(args || {}) });
  }

  async renameRelationshipTopic(situationId, title) {
    throw new Error("The name of a published topic cannot be changed");
  }

  async requestCloseRelationshipTopic(situationId) {
    await this.relationshipRpc('request_close_relationship_topic', { target_situation: situationId });
    this.sendRelationshipEmailNotification('close_request', situationId).catch(e => console.warn('Continuum email notification', e));
  }

  async cancelCloseRelationshipTopic(situationId) {
    await this.relationshipRpc('cancel_close_relationship_topic', { target_situation: situationId });
  }

  async confirmCloseRelationshipTopic(situationId) {
    await this.relationshipRpc('confirm_close_relationship_topic', { target_situation: situationId });
  }

  relationshipStatusLabel(situation, entries, messages) {
    const me = this.relationshipSession?.user?.id;
    if (situation.status === 'closed') return "🔒 Closed";
    if (situation.status === 'close_requested') {
      return situation.close_requested_by === me ? "Closing proposed · waiting for partner" : "Partner proposes closing · your reply is needed";
    }
    const own = entries.find(e => e.author_id === me);
    const other = entries.find(e => e.author_id !== me);
    if (!own) return "Your initial position is needed";
    if (!other) return "Your position is ready · waiting for partner";
    if (!messages.length) return "Discussion is open";
    const latest = messages[messages.length - 1];
    return latest.author_id === me ? "Waiting for your partner's reply" : "● New reply · your turn";
  }

  async getRelationshipSituationSummary(situation) {
    const me = this.relationshipSession?.user?.id;
    const entries = await this.getRelationshipEntries(situation.id);
    const own = entries.find(e => e.author_id === me);
    const other = entries.find(e => e.author_id !== me);
    let messages = [];
    if (own && other) messages = await this.getRelationshipMessages(situation.id).catch(() => []);
    let priority = 1;
    let statusText = this.relationshipStatusLabel(situation, entries, messages);
    if (situation.status === 'closed') priority = 2;
    else if (!own) priority = 0;
    else if (situation.status === 'close_requested' && situation.close_requested_by !== me) priority = 0;
    else if (own && other) {
      const latestOwnReplyAt = messages.filter(m => m.author_id === me).reduce((max, m) => Math.max(max, +new Date(m.created_at)), +new Date(own.updated_at || own.created_at));
      const partnerMessageActivity = messages.filter(m => m.author_id !== me).reduce((max, m) => Math.max(max, +new Date(m.updated_at || m.created_at)), 0);
      const partnerEntryActivity = +new Date(other.updated_at || other.created_at);
      if (Math.max(partnerMessageActivity, partnerEntryActivity) > latestOwnReplyAt) {
        priority = 0;
        statusText = "● New reply or edit · your turn";
      }
    }
    const activityCandidates = [situation.updated_at, situation.created_at, ...entries.map(e => e.updated_at || e.created_at), ...messages.map(m => m.updated_at || m.created_at)].filter(Boolean);
    const activityAt = Math.max(...activityCandidates.map(v => +new Date(v)), 0);
    return { situation, entries, messages, priority, activityAt, statusText };
  }

  async archiveCompletedRelationshipSituation() {
    // Since 2.1.0 the server topic is the source of truth.
    // There is no need to create a local unencrypted copy of the discussion any more.
    return;
  }

  manageSection(section) { new SectionActionsModal(this.app, this, section).open(); }
  openArchive() { new ArchiveModal(this.app, this).open(); }

  async archiveSection(section) {
    const archivedAt = new Date().toISOString();
    let originalPath;
    let archivedPath;

    if (section.type === 'journal') {
      originalPath = `03 Journals/${section.journal}.md`;
      await this.ensureFolder('05 Archive/Journals');
      archivedPath = `05 Archive/Journals/${section.journal}.md`;
    } else {
      originalPath = section.folder;
      await this.ensureFolder('05 Archive/Knowledge');
      archivedPath = `05 Archive/Knowledge/${section.name}`;
    }

    const existingArchive = this.app.vault.getAbstractFileByPath(archivedPath);
    if (existingArchive) {
      new Notice("The Archive already has a section with this name");
      return false;
    }

    const source = this.app.vault.getAbstractFileByPath(originalPath);
    if (source) await this.app.vault.rename(source, archivedPath);

    if (section.source === 'builtin') {
      if (!this.hiddenBuiltins.includes(section.builtinId)) this.hiddenBuiltins.push(section.builtinId);
    } else {
      this.customSections = this.customSections.filter(item => !(item.type === section.type && item.name === section.name));
    }

    this.archivedSections.push({
      source: section.source,
      builtinId: section.builtinId || null,
      type: section.type,
      name: section.name,
      emoji: section.emoji || '📌',
      journal: section.journal || null,
      folder: section.folder || null,
      originalPath,
      archivedPath,
      archivedAt
    });

    await this.saveContinuumData();
    this.refreshSidebar();
    new Notice(`Moved to the Archive: ${section.emoji || '📌'} ${section.name}`);
    return true;
  }

  async restoreArchivedSection(item) {
    if (this.app.vault.getAbstractFileByPath(item.originalPath)) {
      new Notice("Cannot restore: an active section with this name already exists");
      return false;
    }

    const archived = this.app.vault.getAbstractFileByPath(item.archivedPath);
    if (archived) {
      const parentPath = item.originalPath.split('/').slice(0, -1).join('/');
      if (parentPath) await this.ensureFolder(parentPath);
      await this.app.vault.rename(archived, item.originalPath);
    } else if (item.type === 'journal') {
      const content = `# ${item.emoji || '📌'} ${item.name}\n\n`;
      await this.app.vault.create(item.originalPath, content);
    } else {
      await this.ensureFolder(item.originalPath);
    }

    if (item.source === 'builtin') {
      this.hiddenBuiltins = this.hiddenBuiltins.filter(id => id !== item.builtinId);
    } else {
      const restored = item.type === 'journal'
        ? { type: 'journal', name: item.name, emoji: item.emoji || '📌', journal: item.journal || item.name }
        : { type: 'library', name: item.name, emoji: item.emoji || '📌', folder: item.folder || item.originalPath };
      if (!this.customSections.some(section => section.type === restored.type && section.name === restored.name)) this.customSections.push(restored);
    }

    this.archivedSections = this.archivedSections.filter(entry => entry !== item);
    await this.saveContinuumData();
    this.refreshSidebar();
    new Notice(`Restored: ${item.emoji || '📌'} ${item.name}`);
    return true;
  }

  async deleteArchivedSection(item) {
    const archived = this.app.vault.getAbstractFileByPath(item.archivedPath);
    if (archived) await this.app.vault.delete(archived, true);
    this.archivedSections = this.archivedSections.filter(entry => entry !== item);
    await this.saveContinuumData();
    this.refreshSidebar();
    new Notice(item.type === 'journal'
      ? `Section deleted. Daily entries are kept: ${item.name}`
      : `Section deleted: ${item.name}`);
    return true;
  }

  sanitizeName(name) {
    const value = String(name || '')
      .normalize('NFC')
      .replace(/[\u0000-\u001F\u007F\u200B-\u200D\uFEFF]/g, '')
      .replace(/[\\/:*?"<>|#\[\]^]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/[. ]+$/g, '')
      .trim()
      .slice(0, 80);
    if (!value || value === '.' || value === '..') return '';
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) return '';
    return value;
  }

  async ensureFolder(path) {
    if (this.app.vault.getAbstractFileByPath(path)) return;
    const parts = path.split('/');
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current);
    }
  }

  async addCustomSection(name, emoji, type) {
    const clean = this.sanitizeName(name);
    if (!clean) {
      new Notice("The name contains only invalid characters");
      return false;
    }
    const normalized = clean.toLocaleLowerCase('en');
    const existingNames = [
      ...BUILTIN_JOURNALS.map(([, n]) => n.toLocaleLowerCase('en')),
      ...this.customSections.map(s => s.name.toLocaleLowerCase('en'))
    ];
    if (existingNames.includes(normalized)) {
      new Notice("This section already exists");
      return false;
    }

    if (type === 'library') {
      const folder = `02 Knowledge/${clean}`;
      await this.ensureFolder(folder);
      this.customSections.push({ type: 'library', name: clean, emoji: emoji || '📌', folder });
    } else {
      const journal = clean;
      const path = `03 Journals/${journal}.md`;
      if (!this.app.vault.getAbstractFileByPath(path)) await this.app.vault.create(path, `# ${emoji || '📌'} ${journal}\n\n`);
      this.customSections.push({ type: 'journal', name: clean, emoji: emoji || '📌', journal });
    }

    await this.saveContinuumData();
    this.refreshSidebar();
    new Notice(type === 'library' ? `Section created: ${emoji || '📌'} ${clean}` : `Personal section created: ${emoji || '📌'} ${clean}`);
    return true;
  }

  openAddSection(preferredType = 'journal') { new AddSectionModal(this.app, this, preferredType).open(); }
  openMotivation() { new ContinuumMotivationManagerModal(this.app, this).open(); }

  async openJournal(journal, emoji = '📒') {
    await this.ensureFolder('03 Journals');
    const path = `03 Journals/${journal}.md`;
    if (!this.app.vault.getAbstractFileByPath(path)) {
      await this.app.vault.create(path, `# ${emoji} ${journal}\n\n`);
    }
    await this.openTarget(path);
  }

  refreshSidebar() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach(leaf => {
      if (leaf.view && typeof leaf.view.render === 'function') leaf.view.render();
    });
  }

  hasDaily(dateString) { return Boolean(this.app.vault.getAbstractFileByPath(`01 Days/${dateString}.md`)); }

  async activateSidebar() {
    let leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (!leaves.length) {
      const leaf = this.app.workspace.getLeftLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
      leaves = [leaf];
    }
    this.app.workspace.revealLeaf(leaves[0]);
  }

  async openTarget(target) {
    const abstract = this.app.vault.getAbstractFileByPath(target);
    if (abstract && abstract.extension === 'md') {
      await this.app.workspace.getLeaf(false).openFile(abstract);
      return;
    }
    if (abstract && Array.isArray(abstract.children)) {
      const firstMarkdown = abstract.children.find(file => file.extension === 'md');
      if (firstMarkdown) {
        await this.app.workspace.getLeaf(false).openFile(firstMarkdown);
        return;
      }
    }
    new Notice(`The section is empty: ${target}`);
  }

  openLibrary(folderPath, emoji, label) {
    new LibraryModal(this.app, this, folderPath, emoji, label).open();
  }

  async createLibraryFolder(parentPath, name) {
    const clean = this.sanitizeName(name);
    if (!clean) {
      new Notice("Invalid folder name");
      return null;
    }
    await this.ensureFolder(parentPath);
    const path = `${parentPath}/${clean}`;
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing) {
      new Notice("A folder or file with this name already exists");
      return null;
    }
    await this.app.vault.createFolder(path);
    new Notice(`Folder created: ${clean}`);
    return this.app.vault.getAbstractFileByPath(path);
  }

  async createLibraryDocument(folderPath, name) {
    const clean = this.sanitizeName(name);
    if (!clean) {
      new Notice("Invalid file name");
      return null;
    }
    await this.ensureFolder(folderPath);
    const path = `${folderPath}/${clean}.md`;
    let file = this.app.vault.getAbstractFileByPath(path);
    if (!file) file = await this.app.vault.create(path, '');
    else new Notice("A file with this name already exists");
    return file;
  }

  async ensureDate(dateMoment) {
    const date = dateMoment.format('YYYY-MM-DD');
    const path = `01 Days/${date}.md`;
    let file = this.app.vault.getAbstractFileByPath(path);
    if (!file) {
      const template = this.app.vault.getAbstractFileByPath('04 Templates/Day template.md');
      let content = '## Hello 👋 What will you share today? 🤔\n';
      if (template) {
        content = await this.app.vault.read(template);
        content = content.replace(/{{date}}/g, date).replace(/{{dateLong}}/g, dateMoment.format('D MMMM YYYY'));
      }
      file = await this.app.vault.create(path, content);
    }
    return file;
  }

  async openDate(dateMoment) {
    const file = await this.ensureDate(dateMoment);
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  openChoice() { new ChoiceModal(this.app, this, type => this.addEntry(type)).open(); }

  async addEntry(type) {
    let view = this.app.workspace.getActiveViewOfType(MarkdownView);
    let file = view && view.file && view.file.path.startsWith('01 Days/') ? view.file : null;
    if (!file) file = await this.ensureDate(moment());

    await this.app.workspace.getLeaf(false).openFile(file);
    view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const date = file.basename;
    const heading = type.label;
    let starter = '';
    if (type.key === 'idea') starter = '**Topic:** ';
    else if (type.key === 'car') starter = '**Topic:** \n**Mileage:** ';
    const block = `\n## ${heading}\n\n${starter}`;

    if (view && view.file && view.file.path === file.path) {
      const editor = view.editor;
      editor.setCursor(editor.lineCount(), 0);
      editor.replaceSelection(block);
      editor.focus();
    } else {
      await this.app.vault.append(file, block);
    }

    if (type.journal) await this.appendJournal(type.journal, date, heading, file.path);
    new Notice(`Added: ${type.label}`);
  }

  async appendJournal(journal, date, heading, dailyPath) {
    const path = `03 Journals/${journal}.md`;
    let file = this.app.vault.getAbstractFileByPath(path);
    if (!file) file = await this.app.vault.create(path, `# ${journal}\n\n`);
    const target = dailyPath.replace(/\.md$/, '');
    const line = `- [[${target}#${heading}|${formatJournalDate(date)} — ${heading}]]\n`;
    const existing = await this.app.vault.read(file);
    if (!existing.includes(line.trim())) await this.app.vault.append(file, line);
  }
};

/* Knowledge-base compatibility extensions. */
const ContinuumPlugin220 = module.exports;

const continuum220BaseOnload = ContinuumPlugin220.prototype.onload;
ContinuumPlugin220.prototype.onload = async function() {
  await continuum220BaseOnload.call(this);
  const data = (await this.loadData()) || {};
  this.libraryFeatures = data.libraryFeatures && typeof data.libraryFeatures === 'object' ? data.libraryFeatures : {};
  this.libraryDailyLinks = Array.isArray(data.libraryDailyLinks) ? data.libraryDailyLinks : [];
  this.hiddenMotivations = Array.isArray(data.hiddenMotivations) ? data.hiddenMotivations : [];
};

ContinuumPlugin220.prototype.saveContinuumData = async function() {
  const current = (await this.loadData()) || {};
  const next = {
    ...current,
    schemaVersion: this.dataSchemaVersion || CONTINUUM_DATA_SCHEMA_VERSION,
    lastPluginVersion: CONTINUUM_PLUGIN_VERSION,
    customSections: this.customSections,
    hiddenBuiltins: this.hiddenBuiltins,
    archivedSections: this.archivedSections,
    relationshipSettings: this.relationshipSettings,
    sharedUnlockExpiresAt: Number(this.sharedUnlockExpiresAt || 0),
    updateSettings: this.updateSettings || { autoCheck: false, lastCheckedAt: null },
    libraryFeatures: this.libraryFeatures || {},
    libraryDailyLinks: this.libraryDailyLinks || [],
    hiddenMotivations: this.hiddenMotivations || []
  };
  delete next.hiddenPrinciples;
  await this.saveData(next);
};

ContinuumPlugin220.prototype.getLibraryFeature = function(path) {
  return { showInDaily:false, collectDaily:false, checklistMode:false, periodGrouping:false, ...((this.libraryFeatures||{})[path]||{}) };
};
ContinuumPlugin220.prototype.setLibraryFeature = async function(path, patch) {
  this.libraryFeatures = this.libraryFeatures || {};
  this.libraryFeatures[path] = { ...this.getLibraryFeature(path), ...(patch||{}) };
  await this.saveContinuumData();
};
ContinuumPlugin220.prototype.libraryHasDailyTargets = function(rootPath) {
  return Object.entries(this.libraryFeatures||{}).some(([p,f]) => (p===rootPath || p.startsWith(`${rootPath}/`)) && !!f?.showInDaily);
};
ContinuumPlugin220.prototype.getDailyLibraryRoots = function() {
  const roots=[];
  for (const section of this.getCustomLibraries()) if (this.libraryHasDailyTargets(section.folder)) roots.push(section);
  return roots;
};
ContinuumPlugin220.prototype.hasDailyLibraryTargets = function() { return this.getDailyLibraryRoots().length>0; };
ContinuumPlugin220.prototype.getLibraryDailyLinks = function(path) { return (this.libraryDailyLinks||[]).filter(x=>x.targetPath===path).sort((a,b)=>+new Date(b.createdAt||0)-+new Date(a.createdAt||0)); };

ContinuumPlugin220.prototype.addLibraryDailyEntry = async function(targetPath, value) {
  const feature=this.getLibraryFeature(targetPath); let view=this.app.workspace.getActiveViewOfType(MarkdownView); let file=view&&view.file&&view.file.path.startsWith('01 Days/')?view.file:null; if(!file)file=await this.ensureDate(moment());
  const id=`lib-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`; const name=targetPath.split('/').pop(); const heading=`📚 ${name}`;
  // The technical relation lives only in CONTINUUM data.json. Nothing service-like is written into the visible Markdown note.
  const block=`\n## ${heading}\n\n${value}\n`;
  await this.app.vault.append(file,block);
  if(feature.collectDaily){ this.libraryDailyLinks=this.libraryDailyLinks||[]; this.libraryDailyLinks.push({id,targetPath,dailyPath:file.path,heading,text:value,createdAt:new Date().toISOString(),checked:false}); await this.saveContinuumData(); }
  await this.app.workspace.getLeaf(false).openFile(file); new Notice(feature.collectDaily?`Added to the day and linked to "${name}"`:`Added to the day: ${name}`);
};
ContinuumPlugin220.prototype.openLibraryDailyLink = async function(link) {
  const file=this.app.vault.getAbstractFileByPath(link.dailyPath); if(!file||file.extension!=='md')return new Notice("The original daily entry was not found"); await this.app.workspace.getLeaf(false).openFile(file); const view=this.app.workspace.getActiveViewOfType(MarkdownView); if(!view||view.file?.path!==file.path)return;
  const lines=view.editor.getValue().split('\n');
  const firstTextLine=String(link.text||'').split('\n').map(x=>x.trim()).find(Boolean)||'';
  let anchor=-1;
  if(firstTextLine) anchor=lines.findIndex(line=>line.trim()===firstTextLine || line.includes(firstTextLine));
  if(anchor<0){ for(let i=lines.length-1;i>=0;i-=1){ if(lines[i].trim()===`## ${link.heading}` || lines[i].trim()===`## 📚 ${(link.targetPath||'').split('/').pop()}`){anchor=i;break;} } }
  if(anchor>=0){let hl=anchor;while(hl>0&&!/^##\s+/.test(lines[hl]))hl-=1;view.editor.setCursor({line:hl,ch:0});try{view.editor.scrollIntoView({from:{line:hl,ch:0},to:{line:anchor,ch:0}},true);}catch(_){} }
};
ContinuumPlugin220.prototype.setLibraryDailyLinkChecked = async function(id,checked){const l=(this.libraryDailyLinks||[]).find(x=>x.id===id);if(!l)return;l.checked=!!checked;await this.saveContinuumData();};
ContinuumPlugin220.prototype.formLibraryPeriod = async function(path,startDate,endDate){const start=moment(startDate,'YYYY-MM-DD',true),end=moment(endDate,'YYYY-MM-DD',true);if(!start.isValid()||!end.isValid())throw new Error("Invalid dates");const name=`${start.format('DD.MM.YYYY')}–${end.format('DD.MM.YYYY')}`,periodPath=`${path}/${name}`;if(!this.app.vault.getAbstractFileByPath(periodPath))await this.app.vault.createFolder(periodPath);let n=0;for(const l of this.libraryDailyLinks||[]){if(l.targetPath!==path)continue;const d=moment((l.dailyPath.split('/').pop()||'').replace(/\.md$/,''),'YYYY-MM-DD',true);if(d.isValid()&&!d.isBefore(start,'day')&&!d.isAfter(end,'day')){l.targetPath=periodPath;n++;}}this.libraryFeatures=this.libraryFeatures||{};if(!this.libraryFeatures[periodPath])this.libraryFeatures[periodPath]={...this.getLibraryFeature(path),showInDaily:false,periodGrouping:false};await this.saveContinuumData();return n;};

ContinuumPlugin220.prototype.rewriteLibraryPathPrefix = function(oldPath,newPath){const next={};for(const [p,f] of Object.entries(this.libraryFeatures||{})){const np=p===oldPath?newPath:(p.startsWith(`${oldPath}/`)?`${newPath}${p.slice(oldPath.length)}`:p);next[np]=f;}this.libraryFeatures=next;for(const l of this.libraryDailyLinks||[]){if(l.targetPath===oldPath)l.targetPath=newPath;else if(l.targetPath.startsWith(`${oldPath}/`))l.targetPath=`${newPath}${l.targetPath.slice(oldPath.length)}`;}};
ContinuumPlugin220.prototype.renameLibraryItem = async function(item,newName){const clean=this.sanitizeName(newName);if(!clean)throw new Error("Invalid name");const isFolder=Array.isArray(item.children),parent=item.path.split('/').slice(0,-1).join('/'),target=isFolder?`${parent}/${clean}`:`${parent}/${clean}.md`;if(target===item.path)return;if(this.app.vault.getAbstractFileByPath(target))throw new Error("This name already exists");const old=item.path;await this.app.vault.rename(item,target);if(isFolder)this.rewriteLibraryPathPrefix(old,target);await this.saveContinuumData();new Notice(`Renamed: ${clean}`);};
ContinuumPlugin220.prototype.renameCustomSection = async function(section,newName){if(!section||section.source!=='custom')throw new Error("A system section cannot be renamed");const clean=this.sanitizeName(newName);const record=this.customSections.find(x=>x.type===section.type&&x.name===section.name);if(!record)throw new Error("Section not found");if(section.type==='library'){const old=record.folder,parent=old.split('/').slice(0,-1).join('/'),target=`${parent}/${clean}`;if(target!==old&&this.app.vault.getAbstractFileByPath(target))throw new Error("This section already exists");const folder=this.app.vault.getAbstractFileByPath(old);if(folder&&target!==old)await this.app.vault.rename(folder,target);record.name=clean;record.folder=target;this.rewriteLibraryPathPrefix(old,target);}else{const old=`03 Journals/${record.journal}.md`,target=`03 Journals/${clean}.md`;if(target!==old&&this.app.vault.getAbstractFileByPath(target))throw new Error("This journal already exists");const file=this.app.vault.getAbstractFileByPath(old);if(file&&target!==old)await this.app.vault.rename(file,target);record.name=clean;record.journal=clean;}await this.saveContinuumData();this.refreshSidebar();new Notice(`Section renamed: ${clean}`);};
ContinuumPlugin220.prototype.deleteLibraryItem = async function(item){const isFolder=Array.isArray(item.children),old=item.path;await this.app.vault.delete(item,true);if(isFolder){const next={};for(const [p,f] of Object.entries(this.libraryFeatures||{}))if(!(p===old||p.startsWith(`${old}/`)))next[p]=f;this.libraryFeatures=next;this.libraryDailyLinks=(this.libraryDailyLinks||[]).filter(l=>!(l.targetPath===old||l.targetPath.startsWith(`${old}/`)));await this.saveContinuumData();}new Notice("Deleted");};
ContinuumPlugin220.prototype.convertLibraryNoteToFolder = async function(file){if(!file||file.extension!=='md')throw new Error("This is not a note");const parent=file.path.split('/').slice(0,-1).join('/'),folderPath=`${parent}/${file.basename}`;if(this.app.vault.getAbstractFileByPath(folderPath))throw new Error("A folder with this name already exists");const content=await this.app.vault.read(file);await this.app.vault.createFolder(folderPath);if(content.trim())await this.app.vault.rename(file,`${folderPath}/Note.md`);else await this.app.vault.delete(file);new Notice(`Folder created: ${file.basename}`);};

ContinuumPlugin220.prototype.setMotivationVisible = async function(motivation, visible) {
  this.hiddenMotivations = this.hiddenMotivations || [];
  if (visible) this.hiddenMotivations = this.hiddenMotivations.filter(item => item !== motivation);
  else if (!this.hiddenMotivations.includes(motivation)) this.hiddenMotivations.push(motivation);
  await this.saveContinuumData();
};

// Future daily notes get a proper visual heading even if the old template still contains plain text.
ContinuumPlugin220.prototype.ensureDate = async function(dateMoment){const date=dateMoment.format('YYYY-MM-DD'),path=`01 Days/${date}.md`;let file=this.app.vault.getAbstractFileByPath(path);if(!file){const template=this.app.vault.getAbstractFileByPath('04 Templates/Day template.md');let content='## Hello 👋 What will you share today? 🤔\n';if(template){content=await this.app.vault.read(template);content=content.replace(/{{date}}/g,date).replace(/{{dateLong}}/g,dateMoment.format('D MMMM YYYY'));content=content.replace(/^\s*Hello👋\s*what will you share today\?\s*$/mi,'## Hello 👋 What will you share today? 🤔').replace(/^\s*Hello,?\s*what will you share today\?\s*$/mi,'## Hello 👋 What will you share today? 🤔');}file=await this.app.vault.create(path,content);}return file;};


/* Clean technical library markers left by earlier builds. */
const ContinuumPlugin221 = module.exports;
const continuum221BaseOnload = ContinuumPlugin221.prototype.onload;
ContinuumPlugin221.prototype.onload = async function() {
  await continuum221BaseOnload.call(this);
  window.setTimeout(() => this.cleanupLegacyLibraryMarkers221().catch(e => console.warn('CONTINUUM marker cleanup', e)), 1200);
};

ContinuumPlugin221.prototype.cleanupLegacyLibraryMarkers221 = async function() {
  const data = (await this.loadData()) || {};
  if (data.cleanupTechnicalLibraryMarkersV221) return 0;
  let changed = 0;
  const files = this.app.vault.getMarkdownFiles();
  // Remove technical markers created by CONTINUUM and by builds released
  // before the internal rebranding. User text is never touched.
  const markerLine = /^\s*<!--\s*(?:continuum|compass)-library:[^\n]*?-->\s*\n?/gmi;
  for (const file of files) {
    const original = await this.app.vault.read(file);
    const cleaned = original.replace(markerLine, '');
    if (cleaned !== original) {
      await this.app.vault.modify(file, cleaned);
      changed += 1;
    }
  }
  const current = (await this.loadData()) || {};
  current.cleanupTechnicalLibraryMarkersV221 = true;
  await this.saveData(current);
  if (changed) new Notice(`CONTINUUM removed technical lines from notes: ${changed}`);
  return changed;
};


/* Adaptive cards and source-of-truth sync for daily-linked library entries. */
const ContinuumPlugin222 = module.exports;
const continuum222BaseOnload = ContinuumPlugin222.prototype.onload;
ContinuumPlugin222.prototype.onload = async function() {
  await continuum222BaseOnload.call(this);
  this._libraryDailySyncTimers222 = new Map();
  this.registerEvent(this.app.vault.on('modify', file => {
    if (!file || file.extension !== 'md' || !String(file.path || '').startsWith('01 Days/')) return;
    const key = file.path;
    const previous = this._libraryDailySyncTimers222.get(key);
    if (previous) window.clearTimeout(previous);
    const timer = window.setTimeout(() => {
      this._libraryDailySyncTimers222.delete(key);
      this.reconcileLibraryDailyLinksForFile222(file).catch(e => console.warn('CONTINUUM daily link sync', e));
    }, 700);
    this._libraryDailySyncTimers222.set(key, timer);
  }));
  window.setTimeout(() => this.reconcileAllLibraryDailyLinks222().catch(e => console.warn('CONTINUUM initial daily link sync', e)), 1600);
};

ContinuumPlugin222.prototype._normalizeLinkedText222 = function(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
};

ContinuumPlugin222.prototype._textSimilarity222 = function(a, b) {
  const left = new Set(this._normalizeLinkedText222(a).toLocaleLowerCase('en').split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const right = new Set(this._normalizeLinkedText222(b).toLocaleLowerCase('en').split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  if (!left.size || !right.size) return 0;
  let same = 0;
  for (const token of left) if (right.has(token)) same += 1;
  return same / Math.max(left.size, right.size);
};

ContinuumPlugin222.prototype._extractDailyLibrarySections222 = function(content) {
  const lines = String(content || '').replace(/\r\n/g, '\n').split('\n');
  const sections = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^##\s+(.+?)\s*$/);
    if (!match) continue;
    let end = i + 1;
    while (end < lines.length && !/^##\s+/.test(lines[end])) end += 1;
    const body = lines.slice(i + 1, end).join('\n').trim();
    sections.push({ heading: match[1].trim(), body, startLine: i });
    i = end - 1;
  }
  return sections;
};

ContinuumPlugin222.prototype.reconcileLibraryDailyLinksForFile222 = async function(file) {
  if (!file || file.extension !== 'md' || !String(file.path || '').startsWith('01 Days/')) return 0;
  const allLinks = this.libraryDailyLinks || [];
  const links = allLinks.filter(link => link.dailyPath === file.path);
  if (!links.length) return 0;

  const content = await this.app.vault.read(file);
  const sections = this._extractDailyLibrarySections222(content);
  const byHeading = new Map();
  for (const section of sections) {
    if (!byHeading.has(section.heading)) byHeading.set(section.heading, []);
    byHeading.get(section.heading).push(section);
  }

  const keepIds = new Set();
  let changed = false;
  const groups = new Map();
  for (const link of links) {
    const heading = String(link.heading || `📚 ${(link.targetPath || '').split('/').pop() || ''}`).trim();
    if (!groups.has(heading)) groups.set(heading, []);
    groups.get(heading).push(link);
  }

  for (const [heading, groupLinks] of groups.entries()) {
    const candidates = [...(byHeading.get(heading) || [])].map((section, index) => ({ ...section, index, used: false }));
    const orderedLinks = [...groupLinks].sort((a, b) => +new Date(a.createdAt || 0) - +new Date(b.createdAt || 0));

    // First pass: exact content match. This preserves checklist state even when other items are deleted.
    for (const link of orderedLinks) {
      const oldText = this._normalizeLinkedText222(link.text);
      if (!oldText) continue;
      const exact = candidates.find(c => !c.used && this._normalizeLinkedText222(c.body) === oldText);
      if (exact) {
        exact.used = true;
        keepIds.add(link.id);
      }
    }

    // Second pass: strong similarity means the user edited the source text rather than deleting it.
    for (const link of orderedLinks) {
      if (keepIds.has(link.id)) continue;
      let best = null;
      let bestScore = 0;
      for (const candidate of candidates) {
        if (candidate.used || !candidate.body.trim()) continue;
        const score = this._textSimilarity222(link.text, candidate.body);
        if (score > bestScore) { bestScore = score; best = candidate; }
      }
      if (best && bestScore >= 0.55) {
        best.used = true;
        keepIds.add(link.id);
        const nextText = best.body.trim();
        if (this._normalizeLinkedText222(link.text) !== this._normalizeLinkedText222(nextText)) {
          link.text = nextText;
          link.updatedAt = new Date().toISOString();
          changed = true;
        }
      }
    }

    // Final conservative pass: pair the remaining source sections and links in order only when counts match.
    const remainingLinks = orderedLinks.filter(link => !keepIds.has(link.id));
    const remainingSections = candidates.filter(c => !c.used && c.body.trim());
    if (remainingLinks.length && remainingLinks.length === remainingSections.length) {
      for (let i = 0; i < remainingLinks.length; i += 1) {
        const link = remainingLinks[i];
        const section = remainingSections[i];
        section.used = true;
        keepIds.add(link.id);
        const nextText = section.body.trim();
        if (this._normalizeLinkedText222(link.text) !== this._normalizeLinkedText222(nextText)) {
          link.text = nextText;
          link.updatedAt = new Date().toISOString();
          changed = true;
        }
      }
    }
  }

  // Obsidian Sync can deliver data.json and the related Markdown file a few
  // seconds apart. Keep unmatched links during a short grace period instead
  // of deleting them immediately when only one half of the change has arrived.
  const now = Date.now();
  let waitingForSyncedFile = false;
  for (const link of links) {
    if (keepIds.has(link.id)) {
      if (link.syncMissingSince) {
        delete link.syncMissingSince;
        changed = true;
      }
      continue;
    }
    const missingSince = Number(link.syncMissingSince || 0);
    if (!missingSince) {
      link.syncMissingSince = now;
      changed = true;
      keepIds.add(link.id);
      waitingForSyncedFile = true;
    } else if ((now - missingSince) < CONTINUUM_SYNC_GRACE_MS) {
      keepIds.add(link.id);
      waitingForSyncedFile = true;
    }
  }

  const before = allLinks.length;
  this.libraryDailyLinks = allLinks.filter(link => link.dailyPath !== file.path || keepIds.has(link.id));
  const removed = before - this.libraryDailyLinks.length;
  if (removed || changed) await this.saveContinuumData();
  if (waitingForSyncedFile) {
    this._continuumMissingLinkTimers106 = this._continuumMissingLinkTimers106 || new Map();
    const previous = this._continuumMissingLinkTimers106.get(file.path);
    if (previous) window.clearTimeout(previous);
    const timer = window.setTimeout(() => {
      this._continuumMissingLinkTimers106.delete(file.path);
      const currentFile = this.app.vault.getAbstractFileByPath(file.path);
      if (currentFile?.extension === 'md') {
        this.reconcileLibraryDailyLinksForFile222(currentFile)
          .catch(e => console.warn('CONTINUUM: delayed daily-link reconciliation failed', e));
      }
    }, CONTINUUM_SYNC_GRACE_MS + 1000);
    this._continuumMissingLinkTimers106.set(file.path, timer);
  }
  return removed;
};

ContinuumPlugin222.prototype.reconcileAllLibraryDailyLinks222 = async function() {
  const paths = [...new Set((this.libraryDailyLinks || []).map(link => link.dailyPath).filter(Boolean))];
  let removed = 0;
  for (const path of paths) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || file.extension !== 'md') {
      // The file may still be downloading on a second device. A real deletion
      // is handled by the vault delete event in the Sync compatibility layer.
      continue;
    }
    removed += await this.reconcileLibraryDailyLinksForFile222(file);
  }
  if (removed) await this.saveContinuumData();
  return removed;
};


/* Focused iOS form visibility and daily greeting formatting. */
ContinuumPlugin222.prototype.formatDailyGreetings223 = async function() {
  const exact = new Set([
    'Hello👋 what will you share today?',
    'Hello 👋 what will you share today?',
    'Hello, what will you share today?',
    'Hello what will you share today?',
    'Hello👋What will you share today?🤔',
    'Hello 👋 What will you share today? 🤔'
  ].map(value => value.toLocaleLowerCase('en')));
  const fix = (content) => {
    const lines = String(content || '').replace(/\r\n/g, '\n').split('\n');
    let changed = false;
    const out = lines.map(line => {
      const trimmed = line.trim();
      if (/^#{1,6}\s+/.test(trimmed)) return line;
      if (exact.has(trimmed.toLocaleLowerCase('en'))) {
        changed = true;
        return '## Hello 👋 What will you share today? 🤔';
      }
      return line;
    });
    return { changed, content: out.join('\n') };
  };

  const paths = ['04 Templates/Day template.md'];
  for (const file of this.app.vault.getMarkdownFiles()) if (file.path.startsWith('01 Days/')) paths.push(file.path);
  let count = 0;
  for (const path of paths) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || file.extension !== 'md') continue;
    const original = await this.app.vault.read(file);
    const result = fix(original);
    if (result.changed) { await this.app.vault.modify(file, result.content); count += 1; }
  }
  return count;
};

const continuum223BaseOnload = ContinuumPlugin222.prototype.onload;
ContinuumPlugin222.prototype.onload = async function() {
  await continuum223BaseOnload.call(this);
  this.app.workspace.onLayoutReady(() => {
    window.setTimeout(() => this.formatDailyGreetings223().catch(e => console.warn('Continuum greeting migration', e)), 1200);
  });
};


/* Explicit topics for daily blocks and journal aliases. */
const ContinuumPlugin232 = module.exports;
const continuum232BaseOnload = ContinuumPlugin232.prototype.onload;
ContinuumPlugin232.prototype.onload = async function() {
  await continuum232BaseOnload.call(this);
  this._topicJournalTimers232 = new Map();
  this.registerEvent(this.app.vault.on('modify', file => {
    if (!file || file.extension !== 'md' || !String(file.path || '').startsWith('01 Days/')) return;
    const key = file.path;
    const previous = this._topicJournalTimers232.get(key);
    if (previous) window.clearTimeout(previous);
    const timer = window.setTimeout(() => {
      this._topicJournalTimers232.delete(key);
      this.reconcileTopicJournals232(file).catch(e => console.warn('CONTINUUM topic journal sync', e));
    }, 650);
    this._topicJournalTimers232.set(key, timer);
  }));
  window.setTimeout(() => this.reconcileAllTopicJournals232().catch(e => console.warn('CONTINUUM initial topic journal sync', e)), 1800);
};

ContinuumPlugin232.prototype.extractDailyTopic232 = function(content, heading) {
  const escaped = String(heading).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|\\n)##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`);
  const match = String(content || '').match(re);
  if (!match) return null;
  const body = match[1] || '';
  const topic = body.match(/^\\s*(?:\\*\\*)?Topic:(?:\\*\\*)?\\s*(.*?)\\s*$/mi);
  return topic ? String(topic[1] || '').trim() : '';
};

ContinuumPlugin232.prototype.reconcileTopicJournal232 = async function(file, journal, heading) {
  if (!file || !file.path || !file.basename) return;
  const journalPath = `03 Journals/${journal}.md`;
  let journalFile = this.app.vault.getAbstractFileByPath(journalPath);
  if (!journalFile) journalFile = await this.app.vault.create(journalPath, `# ${journal}\n\n`);
  const daily = await this.app.vault.read(file);
  const topic = this.extractDailyTopic232(daily, heading);
  const target = file.path.replace(/\.md$/, '');
  const escapedTarget = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lineRe = new RegExp(`^- \\[\\[${escapedTarget}#${escapedHeading}\\|[^\\]]+\\]\\]\\n?`, 'gm');
  const original = await this.app.vault.read(journalFile);
  // 2.3.3 repairs journals polluted by 2.3.2, where literal \\n text was written instead of real new lines.
  let updated = original.replace(/\\n(?=- \[\[)/g, '\n');
  const targetWithOptionalMd = `${escapedTarget}(?:\\.md)?`;
  const cleanupRe = new RegExp(`^- \\[\\[${targetWithOptionalMd}#${escapedHeading}\\|[^\\]]+\\]\\]\\n?`, 'gm');
  updated = updated.replace(cleanupRe, '');
  if (topic !== null) {
    const alias = `${formatJournalDate(file.basename)} — ${topic || heading}`;
    const line = `- [[${target}#${heading}|${alias}]]\n`;
    if (!updated.endsWith('\n')) updated += '\n';
    updated += line;
  }
  updated = this.sortTopicJournalEntries235(updated);
  if (updated !== original) await this.app.vault.modify(journalFile, updated);
};

/* Selected journals sort newest-first; updater allows skipping intermediate versions. */
ContinuumPlugin232.prototype.sortTopicJournalEntries235 = function(content) {
  const normalized = String(content || '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const entryRe = /^- \[\[01 Days\/(\d{4}-\d{2}-\d{2})(?:\.md)?#[^|\]]+\|[^\]]+\]\]\s*$/;
  const entries = [];
  const rest = [];
  for (const line of lines) {
    const match = line.match(entryRe);
    if (match) entries.push({ line: line.trimEnd(), date: match[1] });
    else rest.push(line);
  }
  if (!entries.length) return normalized;
  entries.sort((a, b) => b.date.localeCompare(a.date));
  while (rest.length && !rest[rest.length - 1].trim()) rest.pop();
  return `${rest.join('\n')}\n\n${entries.map(item => item.line).join('\n')}\n`;
};

ContinuumPlugin232.prototype.reconcileTopicJournals232 = async function(file) {
  const journals = this.getAllTypes().filter(type => type?.journal && type?.label);
  for (const type of journals) {
    await this.reconcileTopicJournal232(file, type.journal, type.label);
  }
};

ContinuumPlugin232.prototype.reconcileAllTopicJournals232 = async function() {
  const files = this.app.vault.getMarkdownFiles().filter(file => String(file.path || '').startsWith('01 Days/'));
  for (const file of files) await this.reconcileTopicJournals232(file);
};


/* Reliable topic aliases for journals on mobile. */
const ContinuumPlugin234 = module.exports;

ContinuumPlugin234.prototype.extractDailyTopic232 = function(content, heading) {
  const lines = String(content || '').replace(/\r\n?/g, '\n').split('\n');
  const wanted = `## ${String(heading || '').trim()}`;
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === wanted) { start = i + 1; break; }
  }
  if (start < 0) return null;
  for (let i = start; i < lines.length; i += 1) {
    const raw = lines[i];
    if (/^##\s+/.test(raw.trim())) break;
    const plain = raw.replace(/\*\*/g, '').trim();
    const match = plain.match(/^Topic\s*:\s*(.*)$/i);
    if (match) return String(match[1] || '').trim();
  }
  return '';
};

const continuum234BaseOpenTarget = ContinuumPlugin234.prototype.openTarget;
ContinuumPlugin234.prototype.openTarget = async function(target) {
  if (String(target || '').startsWith('03 Journals/') && String(target || '').endsWith('.md')) {
    try { await this.reconcileAllTopicJournals232(); }
    catch (e) { console.warn('CONTINUUM journal refresh', e); }
  }
  return continuum234BaseOpenTarget.call(this, target);
};

const continuum234BaseAddEntry = ContinuumPlugin234.prototype.addEntry;
ContinuumPlugin234.prototype.addEntry = async function(type) {
  if (!type || (type.key !== 'idea' && type.key !== 'car')) {
    return continuum234BaseAddEntry.call(this, type);
  }

  let view = this.app.workspace.getActiveViewOfType(MarkdownView);
  let file = view && view.file && view.file.path.startsWith('01 Days/') ? view.file : null;
  if (!file) file = await this.ensureDate(moment());

  await this.app.workspace.getLeaf(false).openFile(file);
  view = this.app.workspace.getActiveViewOfType(MarkdownView);
  const date = file.basename;
  const heading = type.label;
  const starter = type.key === 'idea'
    ? '**Topic:** '
    : '**Topic:** \n**Mileage:** ';
  const block = `\n## ${heading}\n\n${starter}`;

  if (view && view.file && view.file.path === file.path) {
    const editor = view.editor;
    editor.setCursor(editor.lineCount(), 0);
    editor.replaceSelection(block);
    if (type.key === 'car') {
      editor.setCursor({ line: Math.max(0, editor.lineCount() - 2), ch: '**Topic:** '.length });
    } else {
      editor.setCursor({ line: Math.max(0, editor.lineCount() - 1), ch: '**Topic:** '.length });
    }
    editor.focus();
  } else {
    await this.app.vault.append(file, block);
  }

  if (type.journal) await this.appendJournal(type.journal, date, heading, file.path);
  new Notice(`Added: ${type.label}`);
};


/* Topic support for the ordinary local relationship journal. */
const ContinuumPlugin236 = module.exports;

ContinuumPlugin236.prototype.getRelationshipJournalType236 = function() {
  try {
    return this.getAllTypes().find(type => String(type?.journal || '').trim() === 'Relationships') || null;
  } catch (e) {
    return null;
  }
};

const continuum236BaseReconcileTopicJournals = ContinuumPlugin236.prototype.reconcileTopicJournals232;
ContinuumPlugin236.prototype.reconcileTopicJournals232 = async function(file) {
  await continuum236BaseReconcileTopicJournals.call(this, file);
  const type = this.getRelationshipJournalType236();
  if (type?.label) await this.reconcileTopicJournal232(file, 'Relationships', type.label);
};

const continuum236BaseOpenTarget = ContinuumPlugin236.prototype.openTarget;
ContinuumPlugin236.prototype.openTarget = async function(target) {
  if (target === '03 Journals/Relationships.md') {
    try { await this.reconcileAllTopicJournals232(); }
    catch (e) { console.warn('CONTINUUM relationship journal refresh', e); }
  }
  return continuum236BaseOpenTarget.call(this, target);
};

const continuum236BaseAddEntry = ContinuumPlugin236.prototype.addEntry;
ContinuumPlugin236.prototype.addEntry = async function(type) {
  if (!type || String(type.journal || '').trim() !== 'Relationships') {
    return continuum236BaseAddEntry.call(this, type);
  }

  let view = this.app.workspace.getActiveViewOfType(MarkdownView);
  let file = view && view.file && view.file.path.startsWith('01 Days/') ? view.file : null;
  if (!file) file = await this.ensureDate(moment());

  await this.app.workspace.getLeaf(false).openFile(file);
  view = this.app.workspace.getActiveViewOfType(MarkdownView);
  const heading = type.label;
  const block = `\n## ${heading}\n\n**Topic:** `;

  if (view && view.file && view.file.path === file.path) {
    const editor = view.editor;
    editor.setCursor(editor.lineCount(), 0);
    editor.replaceSelection(block);
    editor.setCursor({ line: Math.max(0, editor.lineCount() - 1), ch: '**Topic:** '.length });
    editor.focus();
  } else {
    await this.app.vault.append(file, block);
  }

  await this.reconcileTopicJournal232(file, 'Relationships', heading);
  new Notice(`Added: ${type.label}`);
};


/* CONTINUUM 1.0: every user-created journal uses the same topic workflow. */
const ContinuumPlugin100 = module.exports;

ContinuumPlugin100.prototype.reconcileTopicJournals232 = async function(file) {
  const journals = this.getAllTypes().filter(type => type?.journal && type?.label);
  for (const type of journals) {
    await this.reconcileTopicJournal232(file, type.journal, type.label);
  }
};

const continuum100BaseOpenTarget = ContinuumPlugin100.prototype.openTarget;
ContinuumPlugin100.prototype.openTarget = async function(target) {
  if (String(target || '').startsWith('03 Journals/') && String(target || '').endsWith('.md')) {
    try { await this.reconcileAllTopicJournals232(); }
    catch (e) { console.warn('CONTINUUM: journal refresh failed', e); }
  }
  return continuum100BaseOpenTarget.call(this, target);
};

const continuum100BaseAddEntry = ContinuumPlugin100.prototype.addEntry;
ContinuumPlugin100.prototype.addEntry = async function(type) {
  if (!type?.journal) return continuum100BaseAddEntry.call(this, type);

  let view = this.app.workspace.getActiveViewOfType(MarkdownView);
  let file = view?.file?.path?.startsWith('01 Days/') ? view.file : null;
  if (!file) file = await this.ensureDate(moment());

  await this.app.workspace.getLeaf(false).openFile(file);
  view = this.app.workspace.getActiveViewOfType(MarkdownView);
  const heading = type.label;
  const block = `\n## ${heading}\n\n**Topic:** `;

  if (view?.file?.path === file.path) {
    const editor = view.editor;
    editor.setCursor(editor.lineCount(), 0);
    editor.replaceSelection(block);
    editor.setCursor({ line: Math.max(0, editor.lineCount() - 1), ch: '**Topic:** '.length });
    editor.focus();
  } else {
    await this.app.vault.append(file, block);
  }

  window.setTimeout(() => {
    this.reconcileTopicJournal232(file, type.journal, heading)
      .catch(e => console.warn('CONTINUUM: topic journal sync failed', e));
  }, 700);
  new Notice(`Added: ${type.label}`);
};


/* CONTINUUM 1.0.6: compatibility with Obsidian Sync. */
const ContinuumPlugin106 = module.exports;

ContinuumPlugin106.prototype._normalizeCustomSections106 = function(raw) {
  return (Array.isArray(raw) ? raw : []).map(section => ({
    ...section,
    type: section?.type === 'library' ? 'library' : 'journal',
    name: String(section?.name || '').normalize('NFC'),
    journal: section?.type === 'library'
      ? undefined
      : String(section?.journal || section?.name || '').normalize('NFC'),
    folder: section?.type === 'library'
      ? String(section?.folder || `02 Knowledge/${section?.name || ''}`).normalize('NFC')
      : undefined,
    emoji: section?.emoji || '📌'
  })).filter(section => section.name && (section.journal || section.folder));
};

ContinuumPlugin106.prototype._applySyncedSettings106 = function(data) {
  const previousRelationship = JSON.stringify({
    projectUrl: this.relationshipSettings?.projectUrl || '',
    publishableKey: this.relationshipSettings?.publishableKey || '',
    email: this.relationshipSettings?.email || ''
  });

  this.customSections = this._normalizeCustomSections106(data?.customSections);
  this.hiddenBuiltins = Array.isArray(data?.hiddenBuiltins) ? [...data.hiddenBuiltins] : [];
  this.archivedSections = Array.isArray(data?.archivedSections) ? [...data.archivedSections] : [];
  this.relationshipSettings = {
    projectUrl: data?.relationshipSettings?.projectUrl || '',
    publishableKey: data?.relationshipSettings?.publishableKey || '',
    email: data?.relationshipSettings?.email || '',
    rememberSession: data?.relationshipSettings?.rememberSession === true
  };
  this.updateSettings = {
    autoCheck: data?.updateSettings?.autoCheck === true,
    lastCheckedAt: data?.updateSettings?.lastCheckedAt || null,
    channelId: sanitizeUpdateChannel(data?.updateSettings?.channelId)
  };
  this.libraryFeatures = data?.libraryFeatures && typeof data.libraryFeatures === 'object' && !Array.isArray(data.libraryFeatures)
    ? { ...data.libraryFeatures }
    : {};
  this.libraryDailyLinks = Array.isArray(data?.libraryDailyLinks) ? [...data.libraryDailyLinks] : [];
  this.hiddenMotivations = Array.isArray(data?.hiddenMotivations) ? [...data.hiddenMotivations] : [];
  this.dataSchemaVersion = Number.isInteger(data?.schemaVersion) ? data.schemaVersion : CONTINUUM_DATA_SCHEMA_VERSION;

  const nextRelationship = JSON.stringify({
    projectUrl: this.relationshipSettings.projectUrl,
    publishableKey: this.relationshipSettings.publishableKey,
    email: this.relationshipSettings.email
  });
  return previousRelationship !== nextRelationship;
};

ContinuumPlugin106.prototype._clearDeviceSessionAfterSyncedAccountChange106 = async function() {
  this.relationshipSession = null;
  this.sharedUnlockExpiresAt = 0;
  try {
    if (this.app?.secretStorage?.setSecret) {
      await Promise.resolve(this.app.secretStorage.setSecret(CONTINUUM_SHARED_SESSION_SECRET_ID, ''));
    }
  } catch (e) {
    console.warn('CONTINUUM: could not clear the previous device session after Sync', e);
  }
};

ContinuumPlugin106.prototype._readJournalEmoji106 = async function(file, fallback = '📌') {
  try {
    const content = await this.app.vault.cachedRead(file);
    const firstHeading = String(content || '').match(/^#\s+([^\s#]+)(?:\s+|$)/m);
    const token = firstHeading?.[1] || '';
    if (token && /[^\p{L}\p{N}_-]/u.test(token)) return token;
  } catch (e) {
    console.warn('CONTINUUM: could not read section icon', e);
  }
  return fallback;
};

ContinuumPlugin106.prototype._archiveTimestamp106 = function(item) {
  const value = Number(item?.stat?.mtime || item?.stat?.ctime || 0);
  if (!value) return new Date().toISOString();
  try { return new Date(value).toISOString(); }
  catch (_) { return new Date().toISOString(); }
};

ContinuumPlugin106.prototype.repairSectionsFromVault106 = async function(options = {}) {
  let changed = false;
  const customKeys = new Set((this.customSections || []).map(section => section.type === 'library'
    ? `library:${section.folder}`
    : `journal:${section.journal}`));
  const builtinNames = new Set(BUILTIN_JOURNALS.map(([, name]) => name));

  const journalRoot = this.app.vault.getAbstractFileByPath('03 Journals');
  if (journalRoot && Array.isArray(journalRoot.children)) {
    for (const file of journalRoot.children) {
      if (file?.extension !== 'md' || builtinNames.has(file.basename)) continue;
      const key = `journal:${file.basename}`;
      if (customKeys.has(key)) continue;
      this.customSections.push({
        type: 'journal',
        name: file.basename,
        emoji: await this._readJournalEmoji106(file),
        journal: file.basename
      });
      customKeys.add(key);
      changed = true;
    }
  }

  const libraryRoot = this.app.vault.getAbstractFileByPath('02 Knowledge');
  if (libraryRoot && Array.isArray(libraryRoot.children)) {
    for (const folder of libraryRoot.children) {
      if (!Array.isArray(folder?.children)) continue;
      const key = `library:${folder.path}`;
      if (customKeys.has(key)) continue;
      this.customSections.push({ type: 'library', name: folder.name, emoji: '📚', folder: folder.path });
      customKeys.add(key);
      changed = true;
    }
  }

  const archiveKeys = new Set((this.archivedSections || []).map(item => item.archivedPath));
  const archivedJournalRoot = this.app.vault.getAbstractFileByPath('05 Archive/Journals');
  if (archivedJournalRoot && Array.isArray(archivedJournalRoot.children)) {
    for (const file of archivedJournalRoot.children) {
      if (file?.extension !== 'md' || archiveKeys.has(file.path)) continue;
      const builtin = BUILTIN_JOURNALS.find(([, name]) => name === file.basename);
      this.archivedSections.push({
        source: builtin ? 'builtin' : 'custom',
        builtinId: builtin ? `journal:${file.basename}` : null,
        type: 'journal',
        name: file.basename,
        emoji: builtin?.[0] || await this._readJournalEmoji106(file),
        journal: file.basename,
        folder: null,
        originalPath: `03 Journals/${file.basename}.md`,
        archivedPath: file.path,
        archivedAt: this._archiveTimestamp106(file)
      });
      archiveKeys.add(file.path);
      changed = true;
    }
  }

  const archivedLibraryRoot = this.app.vault.getAbstractFileByPath('05 Archive/Knowledge');
  if (archivedLibraryRoot && Array.isArray(archivedLibraryRoot.children)) {
    for (const folder of archivedLibraryRoot.children) {
      if (!Array.isArray(folder?.children) || archiveKeys.has(folder.path)) continue;
      this.archivedSections.push({
        source: 'custom',
        builtinId: null,
        type: 'library',
        name: folder.name,
        emoji: '📚',
        journal: null,
        folder: `02 Knowledge/${folder.name}`,
        originalPath: `02 Knowledge/${folder.name}`,
        archivedPath: folder.path,
        archivedAt: this._archiveTimestamp106(folder)
      });
      archiveKeys.add(folder.path);
      changed = true;
    }
  }

  if (changed && options.persist !== false) await this.saveContinuumData();
  return changed;
};

ContinuumPlugin106.prototype._stableLinkId106 = function(value) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `sync-${(hash >>> 0).toString(36)}`;
};

ContinuumPlugin106.prototype.recoverLibraryLinksFromVault106 = async function(options = {}) {
  const targetByHeading = new Map();
  const addTarget = targetPath => {
    const cleanPath = String(targetPath || '');
    if (!cleanPath) return;
    const heading = `📚 ${cleanPath.split('/').pop()}`;
    if (!targetByHeading.has(heading)) targetByHeading.set(heading, new Set());
    targetByHeading.get(heading).add(cleanPath);
  };

  for (const [path, feature] of Object.entries(this.libraryFeatures || {})) {
    if (feature?.collectDaily) addTarget(path);
  }
  for (const link of this.libraryDailyLinks || []) addTarget(link.targetPath);
  if (!targetByHeading.size) return 0;

  const links = this.libraryDailyLinks || [];
  const usedIds = new Set();
  let recovered = 0;
  const dailyFiles = this.app.vault.getMarkdownFiles()
    .filter(file => String(file.path || '').startsWith('01 Days/'))
    .sort((a, b) => String(a.path).localeCompare(String(b.path)));

  for (const file of dailyFiles) {
    const content = await this.app.vault.read(file);
    const sections = this._extractDailyLibrarySections222(content);
    const occurrenceByHeading = new Map();
    for (const section of sections) {
      const candidates = [...(targetByHeading.get(section.heading) || [])];
      if (!candidates.length) continue;
      const existingForSection = links.filter(link => link.dailyPath === file.path && String(link.heading || '') === section.heading);
      const knownTargets = [...new Set(existingForSection.map(link => link.targetPath).filter(Boolean))];
      const targetPath = knownTargets.length === 1 ? knownTargets[0] : (candidates.length === 1 ? candidates[0] : '');
      if (!targetPath) continue;

      const normalizedBody = this._normalizeLinkedText222(section.body);
      const exact = existingForSection.find(link =>
        link.targetPath === targetPath &&
        !usedIds.has(link.id) &&
        this._normalizeLinkedText222(link.text) === normalizedBody);
      if (exact) {
        usedIds.add(exact.id);
        continue;
      }

      const occurrence = occurrenceByHeading.get(section.heading) || 0;
      occurrenceByHeading.set(section.heading, occurrence + 1);
      let id = this._stableLinkId106(`${file.path}\u0000${targetPath}\u0000${section.heading}\u0000${occurrence}`);
      let suffix = 1;
      while (links.some(link => link.id === id)) {
        id = `${this._stableLinkId106(`${file.path}\u0000${targetPath}\u0000${section.heading}\u0000${occurrence}`)}-${suffix}`;
        suffix += 1;
      }
      links.push({
        id,
        targetPath,
        dailyPath: file.path,
        heading: section.heading,
        text: section.body.trim(),
        createdAt: /^\d{4}-\d{2}-\d{2}$/.test(file.basename)
          ? `${file.basename}T00:00:00.000Z`
          : this._archiveTimestamp106(file),
        checked: false,
        recoveredBySync: true
      });
      usedIds.add(id);
      recovered += 1;
    }
  }

  this.libraryDailyLinks = links;
  if (recovered && options.persist !== false) await this.saveContinuumData();
  return recovered;
};

ContinuumPlugin106.prototype._applyDeletedVaultPath106 = function(path) {
  const clean = String(path || '');
  let changed = false;
  if (clean.startsWith('01 Days/')) {
    const before = (this.libraryDailyLinks || []).length;
    this.libraryDailyLinks = (this.libraryDailyLinks || []).filter(link => link.dailyPath !== clean);
    changed = changed || before !== this.libraryDailyLinks.length;
  }
  if (clean.startsWith('03 Journals/') && clean.endsWith('.md')) {
    const before = (this.customSections || []).length;
    this.customSections = (this.customSections || []).filter(section => `03 Journals/${section.journal}.md` !== clean);
    changed = changed || before !== this.customSections.length;
  }
  if (clean.startsWith('02 Knowledge/')) {
    const beforeSections = (this.customSections || []).length;
    this.customSections = (this.customSections || []).filter(section => section.type !== 'library' || !(section.folder === clean || section.folder.startsWith(`${clean}/`)));
    const nextFeatures = {};
    for (const [key, feature] of Object.entries(this.libraryFeatures || {})) {
      if (!(key === clean || key.startsWith(`${clean}/`))) nextFeatures[key] = feature;
    }
    const beforeLinks = (this.libraryDailyLinks || []).length;
    this.libraryDailyLinks = (this.libraryDailyLinks || []).filter(link => !(link.targetPath === clean || link.targetPath.startsWith(`${clean}/`)));
    changed = changed || beforeSections !== this.customSections.length || Object.keys(nextFeatures).length !== Object.keys(this.libraryFeatures || {}).length || beforeLinks !== this.libraryDailyLinks.length;
    this.libraryFeatures = nextFeatures;
  }
  if (clean.startsWith('05 Archive/')) {
    const before = (this.archivedSections || []).length;
    this.archivedSections = (this.archivedSections || []).filter(item => !(item.archivedPath === clean || item.archivedPath.startsWith(`${clean}/`)));
    changed = changed || before !== this.archivedSections.length;
  }
  return changed;
};

ContinuumPlugin106.prototype._applyRenamedVaultPath106 = function(file, oldPath) {
  const from = String(oldPath || '');
  const to = String(file?.path || '');
  if (!from || !to || from === to) return false;
  let changed = false;

  if (from.startsWith('01 Days/') && to.startsWith('01 Days/')) {
    for (const link of this.libraryDailyLinks || []) {
      if (link.dailyPath === from) { link.dailyPath = to; changed = true; }
    }
  }

  if (from.startsWith('02 Knowledge/') && to.startsWith('02 Knowledge/')) {
    this.rewriteLibraryPathPrefix(from, to);
    for (const section of this.customSections || []) {
      if (section.type !== 'library' || section.folder !== from) continue;
      section.folder = to;
      section.name = to.split('/').pop();
      changed = true;
    }
    changed = true;
  }

  if (from.startsWith('03 Journals/') && to.startsWith('03 Journals/') && from.endsWith('.md') && to.endsWith('.md')) {
    const oldName = from.split('/').pop().replace(/\.md$/, '');
    const newName = to.split('/').pop().replace(/\.md$/, '');
    for (const section of this.customSections || []) {
      if (section.type !== 'journal' || section.journal !== oldName) continue;
      section.journal = newName;
      section.name = newName;
      changed = true;
    }
  }

  for (const item of this.archivedSections || []) {
    if (item.archivedPath === from) { item.archivedPath = to; changed = true; }
  }
  return changed;
};

ContinuumPlugin106.prototype._scheduleVaultSyncRefresh106 = function(paths = [], stateChanged = false) {
  this._continuumPendingVaultPaths106 = this._continuumPendingVaultPaths106 || new Set();
  for (const path of paths) if (path) this._continuumPendingVaultPaths106.add(String(path));
  this._continuumVaultStateDirty106 = this._continuumVaultStateDirty106 || stateChanged;
  if (this._continuumVaultSyncTimer106) window.clearTimeout(this._continuumVaultSyncTimer106);
  this._continuumVaultSyncTimer106 = window.setTimeout(() => {
    this._continuumVaultSyncTimer106 = null;
    const pending = [...this._continuumPendingVaultPaths106];
    this._continuumPendingVaultPaths106.clear();
    this._continuumVaultRefreshQueue106 = (this._continuumVaultRefreshQueue106 || Promise.resolve())
      .then(() => this._refreshAfterVaultSync106(pending))
      .catch(e => console.warn('CONTINUUM: Sync refresh failed', e));
  }, 900);
};

ContinuumPlugin106.prototype._refreshAfterVaultSync106 = async function(paths = []) {
  let changed = this._continuumVaultStateDirty106 === true;
  this._continuumVaultStateDirty106 = false;
  changed = (await this.repairSectionsFromVault106({ persist: false })) || changed;

  const dailyPaths = [...new Set(paths.filter(path => String(path).startsWith('01 Days/')))];
  for (const path of dailyPaths) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file?.extension !== 'md') continue;
    await this.reconcileLibraryDailyLinksForFile222(file);
    await this.reconcileTopicJournals232(file);
  }
  const recovered = await this.recoverLibraryLinksFromVault106({ persist: false });
  if (recovered) changed = true;
  if (changed) await this.saveContinuumData();
  this.refreshSidebar();
};

ContinuumPlugin106.prototype.reloadAfterExternalSettingsChange106 = async function() {
  if (this._continuumApplyingSyncedSettings106) return;
  this._continuumApplyingSyncedSettings106 = true;
  try {
    const data = await this.loadAndMigrateContinuumData();
    const relationshipChanged = this._applySyncedSettings106(data);
    if (relationshipChanged) await this._clearDeviceSessionAfterSyncedAccountChange106();
    let changed = await this.repairSectionsFromVault106({ persist: false });
    await this.reconcileAllLibraryDailyLinks222();
    await this.reconcileAllTopicJournals232();
    const recovered = await this.recoverLibraryLinksFromVault106({ persist: false });
    if (relationshipChanged || recovered) changed = true;
    if (changed) await this.saveContinuumData();
    this.refreshSidebar();
  } finally {
    this._continuumApplyingSyncedSettings106 = false;
  }
};

ContinuumPlugin106.prototype.onExternalSettingsChange = async function() {
  this._continuumExternalSettingsQueue106 = (this._continuumExternalSettingsQueue106 || Promise.resolve())
    .then(() => this.reloadAfterExternalSettingsChange106())
    .catch(e => console.warn('CONTINUUM: could not apply settings received through Obsidian Sync', e));
  await this._continuumExternalSettingsQueue106;
};

const continuum106BaseOnload = ContinuumPlugin106.prototype.onload;
ContinuumPlugin106.prototype.onload = async function() {
  await continuum106BaseOnload.call(this);
  this._continuumPendingVaultPaths106 = new Set();
  this._continuumVaultRefreshQueue106 = Promise.resolve();
  this._continuumVaultStateDirty106 = false;

  this.registerEvent(this.app.vault.on('create', file => {
    this._scheduleVaultSyncRefresh106([file?.path]);
  }));
  this.registerEvent(this.app.vault.on('modify', file => {
    const path = String(file?.path || '');
    if (path.startsWith('01 Days/') || path === 'Motivation.md' || path.startsWith('02 Knowledge/') || path.startsWith('03 Journals/')) {
      this._scheduleVaultSyncRefresh106([path]);
    }
  }));
  this.registerEvent(this.app.vault.on('delete', file => {
    const path = String(file?.path || '');
    const changed = this._applyDeletedVaultPath106(path);
    this._scheduleVaultSyncRefresh106([path], changed);
  }));
  this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
    const changed = this._applyRenamedVaultPath106(file, oldPath);
    this._scheduleVaultSyncRefresh106([oldPath, file?.path], changed);
  }));

  this.app.workspace.onLayoutReady(() => {
    window.setTimeout(() => {
      this._continuumVaultRefreshQueue106 = this._continuumVaultRefreshQueue106
        .then(async () => {
          let changed = await this.repairSectionsFromVault106({ persist: false });
          await this.reconcileAllLibraryDailyLinks222();
          await this.reconcileAllTopicJournals232();
          const recovered = await this.recoverLibraryLinksFromVault106({ persist: false });
          if (recovered) changed = true;
          if (changed) await this.saveContinuumData();
          this.refreshSidebar();
        })
        .catch(e => console.warn('CONTINUUM: initial Sync compatibility check failed', e));
    }, 2400);
  });
};

/* CONTINUUM 1.0.7: internal identifiers now use the CONTINUUM namespace. */

const continuum106BaseOnunload = ContinuumPlugin106.prototype.onunload;
ContinuumPlugin106.prototype.onunload = async function() {
  if (this._continuumVaultSyncTimer106) window.clearTimeout(this._continuumVaultSyncTimer106);
  for (const timer of this._continuumMissingLinkTimers106?.values?.() || []) window.clearTimeout(timer);
  if (continuum106BaseOnunload) await continuum106BaseOnunload.call(this);
};
