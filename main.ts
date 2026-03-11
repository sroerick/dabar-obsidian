import {
	App,
	Editor,
	FileView,
	ItemView,
	MarkdownView,
	Modal,
	Notice,
	Keymap,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	ViewStateResult,
	WorkspaceLeaf,
	requestUrl,
} from "obsidian";
import { EditorView } from "@codemirror/view";

interface BiblePluginSettings {
	apiBaseUrl: string;
	strongsApiBaseUrl: string;
	translation: string;
	includeFootnotes: boolean;
}

const DEFAULT_SETTINGS: BiblePluginSettings = {
	apiBaseUrl: "https://bible.helloao.org/api",
	strongsApiBaseUrl: "https://bible.helloao.org/api",
	translation: "BSB",
	includeFootnotes: false,
};

const BIBLE_READER_VIEW_TYPE = "bible-reader-view";
const BIBLE_BACKLINKS_VIEW_TYPE = "bible-backlinks-view";
const BIBLE_BROWSER_VIEW_TYPE = "bible-browser-view";
const BIBLE_STRONGS_VIEW_TYPE = "bible-strongs-view";
const ENABLE_STRONGS_SIDEBAR = false;
const BIBLE_GRAPH_START = "<!-- BSB_GRAPH_LINKS_START -->";
const BIBLE_GRAPH_END = "<!-- BSB_GRAPH_LINKS_END -->";

interface ApiBook {
	id: string;
	name: string;
	commonName?: string;
	title?: string;
	chapterCount?: number;
}

interface ApiBooksResponse {
	books: ApiBook[];
}

interface ApiTextFragment {
	text?: string;
	heading?: string;
	noteId?: number;
	lineBreak?: boolean;
}

interface ApiVerseItem {
	type: "verse";
	verse: number;
	content: Array<string | ApiTextFragment>;
}

interface ApiHeadingItem {
	type: "heading";
	content: string;
}

interface ApiSubtitleItem {
	type: "hebrew_subtitle";
	content: string;
}

interface ApiLineBreakItem {
	type: "line_break";
	content: null;
}

type ApiChapterItem = ApiVerseItem | ApiHeadingItem | ApiSubtitleItem | ApiLineBreakItem;

interface ApiFootnote {
	noteId: number;
	content: string;
}

interface ApiChapterResponse {
	translation?: string;
	book: {
		id: string;
		name: string;
		commonName?: string;
		title?: string;
	};
	chapter: number;
	content: ApiChapterItem[];
	notes?: ApiFootnote[];
}

interface StrongsEntry {
	code: string;
	lemma?: string;
	transliteration?: string;
	pronunciation?: string;
	definition?: string;
	derivation?: string;
	kjvDefinition?: string;
	occurrences?: number;
	references?: string[];
}

interface RawApiChapterContentVerse {
	type?: string;
	number?: number;
	verse?: number;
	content?: unknown;
}

type ReferencePromptMode = "chapter" | "link" | "passage";
type ReferenceSuggestionProvider = (query: string) => string[];

interface ParsedReference {
	original: string;
	bookId: string;
	bookName: string;
	chapter: number;
	verseStart?: number;
	verseEnd?: number;
}

interface BibleUriMatch {
	uri: string;
	start: number;
	end: number;
}

interface BibleCitationMatch {
	start: number;
	end: number;
	parsed: ParsedReference;
}

interface BibleTextProvider {
	getBooks(translation: string): Promise<ApiBook[]>;
	getChapter(translation: string, bookId: string, chapter: number): Promise<ApiChapterResponse>;
	clearCaches(): void;
}

class HelloAoApiProvider implements BibleTextProvider {
	private booksCache = new Map<string, ApiBook[]>();
	private chapterCache = new Map<string, ApiChapterResponse>();

	constructor(private readonly getSettings: () => BiblePluginSettings) {}

	clearCaches(): void {
		this.booksCache.clear();
		this.chapterCache.clear();
	}

	async getBooks(translation: string): Promise<ApiBook[]> {
		const translationKey = translation.toUpperCase();
		const cached = this.booksCache.get(translationKey);
		if (cached) {
			return cached;
		}

		const baseUrl = this.buildBaseUrl();
		const url = `${baseUrl}/${encodeURIComponent(translationKey)}/books.json`;
		const response = await requestUrl({ method: "GET", url });

		if (response.status < 200 || response.status >= 300) {
			throw new Error(`Failed to fetch books (${response.status}).`);
		}

		const payload = response.json as ApiBooksResponse;
		const books = this.normalizeBooks(payload);
		if (!books || books.length === 0) {
			throw new Error("Books response is missing expected data.");
		}

		this.booksCache.set(translationKey, books);
		return books;
	}

	async getChapter(translation: string, bookId: string, chapter: number): Promise<ApiChapterResponse> {
		const translationKey = translation.toUpperCase();
		const chapterKey = `${translationKey}:${bookId.toUpperCase()}:${chapter}`;
		const cached = this.chapterCache.get(chapterKey);
		if (cached) {
			return cached;
		}

		const baseUrl = this.buildBaseUrl();
		const url = `${baseUrl}/${encodeURIComponent(translationKey)}/${encodeURIComponent(
			bookId.toUpperCase()
		)}/${chapter}.json`;
		const response = await requestUrl({ method: "GET", url });

		if (response.status < 200 || response.status >= 300) {
			throw new Error(`Failed to fetch chapter (${response.status}).`);
		}

		const payload = response.json as ApiChapterResponse;
		const normalized = this.normalizeChapter(payload, bookId, chapter);
		if (!normalized || !Array.isArray(normalized.content) || normalized.content.length === 0) {
			throw new Error("Chapter response is missing expected data.");
		}

		this.chapterCache.set(chapterKey, normalized);
		return normalized;
	}

	private buildBaseUrl(): string {
		return this.getSettings().apiBaseUrl.trim().replace(/\/+$/, "");
	}

	private normalizeBooks(payload: unknown): ApiBook[] {
		if (!payload || typeof payload !== "object") {
			return [];
		}
		const maybeBooks = (payload as { books?: unknown }).books;
		if (!Array.isArray(maybeBooks)) {
			return [];
		}

		const books: ApiBook[] = [];
		for (const entry of maybeBooks) {
			if (!entry || typeof entry !== "object") {
				continue;
			}
			const raw = entry as Record<string, unknown>;
			const id = typeof raw.id === "string" ? raw.id : "";
			const name = typeof raw.name === "string" ? raw.name : "";
			if (!id || !name) {
				continue;
			}
			books.push({
				id,
				name,
				commonName: typeof raw.commonName === "string" ? raw.commonName : undefined,
				title: typeof raw.title === "string" ? raw.title : undefined,
				chapterCount:
					typeof raw.chapterCount === "number"
						? raw.chapterCount
						: typeof raw.numberOfChapters === "number"
							? raw.numberOfChapters
							: undefined,
			});
		}
		return books;
	}

	private normalizeChapter(payload: unknown, fallbackBookId: string, fallbackChapter: number): ApiChapterResponse | null {
		if (!payload || typeof payload !== "object") {
			return null;
		}
		const raw = payload as Record<string, unknown>;
		const rawBook = (raw.book && typeof raw.book === "object" ? raw.book : {}) as Record<string, unknown>;
		const rawChapter = (raw.chapter && typeof raw.chapter === "object"
			? raw.chapter
			: {}) as Record<string, unknown>;

		const rawContent = Array.isArray(raw.content)
			? raw.content
			: Array.isArray(rawChapter.content)
				? rawChapter.content
				: [];
		const content = this.normalizeChapterContent(rawContent);

		const chapterNumber =
			typeof raw.chapter === "number"
				? raw.chapter
				: typeof rawChapter.number === "number"
					? rawChapter.number
					: fallbackChapter;

		const notes = this.normalizeNotes(
			Array.isArray(raw.notes) ? raw.notes : Array.isArray(rawChapter.notes) ? rawChapter.notes : []
		);

		return {
			translation:
				typeof raw.translation === "string"
					? raw.translation
					: (raw.translation &&
								typeof raw.translation === "object" &&
								typeof (raw.translation as Record<string, unknown>).id === "string")
						? ((raw.translation as Record<string, unknown>).id as string)
						: undefined,
			book: {
				id: typeof rawBook.id === "string" ? rawBook.id : fallbackBookId,
				name:
					typeof rawBook.name === "string"
						? rawBook.name
						: typeof rawBook.commonName === "string"
							? (rawBook.commonName as string)
							: fallbackBookId,
				commonName: typeof rawBook.commonName === "string" ? rawBook.commonName : undefined,
				title: typeof rawBook.title === "string" ? rawBook.title : undefined,
			},
			chapter: chapterNumber,
			content,
			notes,
		};
	}

	private normalizeChapterContent(items: unknown[]): ApiChapterItem[] {
		const output: ApiChapterItem[] = [];
		for (const item of items) {
			if (!item || typeof item !== "object") {
				continue;
			}
			const raw = item as Record<string, unknown>;
			const type = typeof raw.type === "string" ? raw.type : "";
			if (type === "line_break") {
				output.push({ type: "line_break", content: null });
				continue;
			}
			if (type === "heading") {
				const heading = this.normalizeChunkText(raw.content);
				if (heading) {
					output.push({ type: "heading", content: heading });
				}
				continue;
			}
			if (type === "hebrew_subtitle") {
				const subtitle = this.normalizeChunkText(raw.content);
				if (subtitle) {
					output.push({ type: "hebrew_subtitle", content: subtitle });
				}
				continue;
			}
			if (type === "verse") {
				const verseItem = raw as RawApiChapterContentVerse;
				const verse =
					typeof verseItem.verse === "number"
						? verseItem.verse
						: typeof verseItem.number === "number"
							? verseItem.number
							: null;
				if (!verse) {
					continue;
				}
				const content = Array.isArray(verseItem.content)
					? this.normalizeVerseFragments(verseItem.content)
					: typeof verseItem.content === "string"
						? [verseItem.content]
						: [];
				output.push({ type: "verse", verse, content });
			}
		}
		return output;
	}

	private normalizeChunkText(value: unknown): string {
		if (typeof value === "string") {
			return value.trim();
		}
		if (Array.isArray(value)) {
			return value
				.map((entry) => (typeof entry === "string" ? entry : ""))
				.join(" ")
				.replace(/\s+/g, " ")
				.trim();
		}
		return "";
	}

	private normalizeVerseFragments(fragments: unknown[]): Array<string | ApiTextFragment> {
		const out: Array<string | ApiTextFragment> = [];
		for (const fragment of fragments) {
			if (typeof fragment === "string") {
				out.push(fragment);
				continue;
			}
			if (!fragment || typeof fragment !== "object") {
				continue;
			}
			const raw = fragment as Record<string, unknown>;
			const normalized: ApiTextFragment = {};
			if (typeof raw.text === "string") {
				normalized.text = raw.text;
			}
			if (typeof raw.heading === "string") {
				normalized.heading = raw.heading;
			}
			if (typeof raw.noteId === "number") {
				normalized.noteId = raw.noteId;
			}
			if (raw.lineBreak === true) {
				normalized.lineBreak = true;
			}
			if (Object.keys(normalized).length > 0) {
				out.push(normalized);
			}
		}
		return out;
	}

	private normalizeNotes(notesRaw: unknown[]): ApiFootnote[] | undefined {
		const notes: ApiFootnote[] = [];
		for (const note of notesRaw) {
			if (!note || typeof note !== "object") {
				continue;
			}
			const raw = note as Record<string, unknown>;
			const noteId = typeof raw.noteId === "number" ? raw.noteId : null;
			const content =
				typeof raw.content === "string"
					? raw.content
					: Array.isArray(raw.content)
						? raw.content
								.map((entry) => (typeof entry === "string" ? entry : ""))
								.join(" ")
								.trim()
						: "";
			if (noteId === null || content.length === 0) {
				continue;
			}
			notes.push({ noteId, content });
		}
		return notes.length > 0 ? notes : undefined;
	}
}

class ReferenceInputModal extends Modal {
	private resolver: ((value: string | null) => void) | null = null;
	private submitted = false;
	private suggestions: string[] = [];
	private selectedSuggestionIndex = 0;
	private suggestionWasExplicitlySelected = false;
	private inputEl: HTMLInputElement | null = null;
	private suggestionsEl: HTMLDivElement | null = null;

	constructor(
		app: App,
		private readonly titleText: string,
		private readonly placeholder: string,
		private readonly initialValue = "",
		private readonly suggestionProvider?: ReferenceSuggestionProvider
	) {
		super(app);
	}

	waitForResult(): Promise<string | null> {
		return new Promise((resolve) => {
			this.resolver = resolve;
			this.open();
		});
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: this.titleText });

		const input = contentEl.createEl("input", {
			attr: {
				type: "text",
				placeholder: this.placeholder,
			},
		});
		input.style.width = "100%";
		input.value = this.initialValue;
		this.inputEl = input;

		const suggestionsEl = contentEl.createDiv({ cls: "bible-reference-suggestions" });
		suggestionsEl.style.marginTop = "0.5rem";
		suggestionsEl.style.maxHeight = "220px";
		suggestionsEl.style.overflowY = "auto";
		suggestionsEl.style.border = "1px solid var(--background-modifier-border)";
		suggestionsEl.style.borderRadius = "6px";
		this.suggestionsEl = suggestionsEl;

		const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });
		const submitButton = buttonRow.createEl("button", { text: "OK" });
		submitButton.addClass("mod-cta");
		const cancelButton = buttonRow.createEl("button", { text: "Cancel" });

		submitButton.addEventListener("click", () => {
			this.finish(input.value.trim() || null);
		});

		cancelButton.addEventListener("click", () => {
			this.finish(null);
		});

		input.addEventListener("keydown", (event) => {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				this.suggestionWasExplicitlySelected = true;
				this.moveSelection(event.key === "ArrowDown" ? 1 : -1);
				return;
			}
			if (event.key === "Tab" && this.suggestions.length > 0) {
				event.preventDefault();
				this.suggestionWasExplicitlySelected = true;
				this.applySelectedSuggestion();
				return;
			}
			if (event.key === "Enter") {
				event.preventDefault();
				if (this.suggestions.length > 0 && this.suggestionWasExplicitlySelected) {
					this.applySelectedSuggestion();
				}
				this.finish(input.value.trim() || null);
			}
			if (event.key === "Escape") {
				event.preventDefault();
				this.finish(null);
			}
		});

		input.addEventListener("input", () => {
			this.suggestionWasExplicitlySelected = false;
			this.refreshSuggestions();
		});

		this.refreshSuggestions();

		window.setTimeout(() => input.focus(), 0);
	}

	onClose(): void {
		this.contentEl.empty();
		this.inputEl = null;
		this.suggestionsEl = null;
		if (!this.submitted) {
			this.submitted = true;
			this.resolver?.(null);
			this.resolver = null;
		}
	}

	private finish(value: string | null): void {
		if (this.submitted) {
			return;
		}
		this.submitted = true;
		this.close();
		this.resolver?.(value);
		this.resolver = null;
	}

	private refreshSuggestions(): void {
		if (!this.inputEl || !this.suggestionsEl || !this.suggestionProvider) {
			return;
		}
		this.suggestions = this.suggestionProvider(this.inputEl.value.trim()).slice(0, 12);
		this.selectedSuggestionIndex = 0;
		this.suggestionWasExplicitlySelected = false;
		this.renderSuggestions();
	}

	private renderSuggestions(): void {
		if (!this.suggestionsEl || !this.inputEl) {
			return;
		}
		this.suggestionsEl.empty();
		if (this.suggestions.length === 0) {
			const empty = this.suggestionsEl.createDiv({ text: "No suggestions" });
			empty.style.padding = "0.5rem 0.75rem";
			empty.style.color = "var(--text-muted)";
			return;
		}

		this.suggestions.forEach((suggestion, index) => {
			const option = this.suggestionsEl?.createDiv({ text: suggestion });
			if (!option) {
				return;
			}
			option.style.padding = "0.5rem 0.75rem";
			option.style.cursor = "pointer";
			if (index === this.selectedSuggestionIndex) {
				option.style.backgroundColor = "var(--background-modifier-hover)";
			}
			option.addEventListener("mouseenter", () => {
				this.selectedSuggestionIndex = index;
				this.renderSuggestions();
			});
			option.addEventListener("mousedown", (event) => {
				event.preventDefault();
				this.selectedSuggestionIndex = index;
				this.suggestionWasExplicitlySelected = true;
				this.applySelectedSuggestion();
				this.finish(this.inputEl?.value.trim() || null);
			});
		});
	}

	private moveSelection(delta: number): void {
		if (this.suggestions.length === 0) {
			return;
		}
		const next = (this.selectedSuggestionIndex + delta + this.suggestions.length) % this.suggestions.length;
		this.selectedSuggestionIndex = next;
		this.renderSuggestions();
	}

	private applySelectedSuggestion(): void {
		if (!this.inputEl || this.suggestions.length === 0) {
			return;
		}
		const selected = this.suggestions[this.selectedSuggestionIndex];
		this.inputEl.value = selected;
	}
}

export default class BereanStandardBibleBrowser extends Plugin {
	settings: BiblePluginSettings = DEFAULT_SETTINGS;
	private provider: BibleTextProvider | null = null;
	private bookLookup = new Map<string, ApiBook>();
	private bookById = new Map<string, ApiBook>();
	private orderedBooks: ApiBook[] = [];
	private loadedTranslation = "";
	private activeReaderReference: ParsedReference | null = null;
	private strongsCache = new Map<string, StrongsEntry>();

	async onload(): Promise<void> {
		await this.loadSettings();
		this.provider = new HelloAoApiProvider(() => this.settings);

		try {
			await this.refreshBooks(true);
		} catch (error) {
			console.error("[BSB Browser] Failed initial book load", error);
		}
		this.registerView(BIBLE_READER_VIEW_TYPE, (leaf) => new BibleReaderView(leaf, this));
		this.registerView(BIBLE_BACKLINKS_VIEW_TYPE, (leaf) => new BibleBacklinksView(leaf, this));
		this.registerView(BIBLE_BROWSER_VIEW_TYPE, (leaf) => new BibleBrowserView(leaf, this));
		if (ENABLE_STRONGS_SIDEBAR) {
			this.registerView(BIBLE_STRONGS_VIEW_TYPE, (leaf) => new BibleStrongsView(leaf, this));
		}

		this.addCommand({
			id: "open-bible-reference",
			name: "Open Bible chapter from reference",
			callback: async () => {
				await this.runWithErrorNotice(() => this.openReferenceFromPrompt());
			},
		});

		this.addCommand({
			id: "open-bible-browser",
			name: "Open Bible browser page",
			callback: async () => {
				await this.runWithErrorNotice(async () => {
					await this.openBibleBrowserPage();
				});
			},
		});

		this.addRibbonIcon("book-open", "Open Bible browser", () => {
			void this.runWithErrorNotice(async () => {
				await this.openBibleBrowserPage();
			});
		});

		this.addCommand({
			id: "open-bible-backlinks-sidebar",
			name: "Open Bible backlinks sidebar",
			callback: async () => {
				await this.runWithErrorNotice(async () => {
					await this.openBacklinksSidebar();
				});
			},
		});

		if (ENABLE_STRONGS_SIDEBAR) {
			this.addCommand({
				id: "lookup-strongs-code",
				name: "Lookup Strong's code",
				callback: async () => {
					await this.runWithErrorNotice(async () => {
						const raw = await this.promptForStrongsCode();
						if (!raw) {
							return;
						}
						const code = this.normalizeStrongsCode(raw);
						if (!code) {
							new Notice("Use format like G3056 or H7225.");
							return;
						}
						await this.openStrongsSidebar(code);
					});
				},
			});
		}

		this.addCommand({
			id: "insert-bible-uri-link",
			name: "Insert Bible wiki link",
			callback: async () => {
				await this.runWithErrorNotice(async () => {
					const editor = this.getActiveEditor();
					if (!editor) {
						new Notice("No active markdown editor found.");
						return;
					}
					await this.insertBibleUriLink(editor);
				});
			},
		});

		this.addCommand({
			id: "insert-bible-passage",
			name: "Insert Bible passage quote",
			callback: async () => {
				await this.runWithErrorNotice(async () => {
					const editor = this.getActiveEditor();
					if (!editor) {
						new Notice("No active markdown editor found.");
						return;
					}
					await this.insertPassage(editor);
				});
			},
		});

		this.addCommand({
			id: "convert-bible-citation-to-link",
			name: "Convert Bible citation to wiki Bible link",
			callback: async () => {
				await this.runWithErrorNotice(async () => {
					const editor = this.getActiveEditor();
					if (!editor) {
						new Notice("No active markdown editor found.");
						return;
					}
					await this.convertBibleCitationAtCursorToLink(editor);
				});
			},
		});

		this.addCommand({
			id: "convert-bible-link-to-quote",
			name: "Turn Bible link at cursor into quote",
			callback: async () => {
				await this.runWithErrorNotice(async () => {
					const editor = this.getActiveEditor();
					if (!editor) {
						new Notice("No active markdown editor found.");
						return;
					}
					await this.convertBibleLinkAtCursorToQuote(editor);
				});
			},
		});

		this.addCommand({
			id: "convert-legacy-markdown-bible-links-active-file",
			name: "Convert Markdown Bible links to wiki in active note",
			callback: async () => {
				await this.runWithErrorNotice(async () => {
					await this.convertLegacyLinksInActiveFile();
				});
			},
		});

		this.addCommand({
			id: "convert-legacy-markdown-bible-links-vault",
			name: "Convert Markdown Bible links to wiki in entire vault",
			callback: async () => {
				await this.runWithErrorNotice(async () => {
					await this.convertLegacyLinksInVault();
				});
			},
		});

		this.addCommand({
			id: "remove-legacy-bible-graph-section-active-note",
			name: "Remove legacy BSB graph section in active note",
			callback: async () => {
				await this.runWithErrorNotice(async () => {
					await this.removeLegacyGraphSectionInActiveFile();
				});
			},
		});

		this.addCommand({
			id: "remove-legacy-bible-graph-section-vault",
			name: "Remove legacy BSB graph section in entire vault",
			callback: async () => {
				await this.runWithErrorNotice(async () => {
					await this.removeLegacyGraphSectionInVault();
				});
			},
		});

		this.registerEvent(
			this.app.workspace.on("window-open", (_win, openedWindow) => {
				this.registerBibleLinkHandlersForWindow(openedWindow);
			})
		);
		this.registerBibleLinkHandlersForWindow(window);
		this.registerMarkdownPostProcessor((el) => {
			this.decorateBibleProtocolLinks(el);
		});

		this.addSettingTab(new BibleSettingTab(this.app, this));
	}

	async onunload(): Promise<void> {
		this.provider?.clearCaches();
	}

	async loadSettings(): Promise<void> {
		const data = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async refreshBooks(force = false): Promise<void> {
		if (!this.provider) {
			return;
		}
		if (!force && this.loadedTranslation === this.settings.translation && this.bookLookup.size > 0) {
			return;
		}

		const books = await this.provider.getBooks(this.settings.translation);
		this.bookLookup.clear();
		this.bookById.clear();
		this.orderedBooks = books;

		for (const book of books) {
			this.bookById.set(book.id.toUpperCase(), book);

			const names = [book.name, book.commonName, book.title, book.id].filter(
				(value): value is string => Boolean(value)
			);
			for (const name of names) {
				this.bookLookup.set(this.normalizeBookName(name), book);
			}
		}

		this.addAlias("revelations", "revelation");
		this.addAlias("song of songs", "song of solomon");
		this.addAlias("canticles", "song of solomon");
		this.addAlias("psalm", "psalms");
		this.addAlias("ps", "psalms");

		this.loadedTranslation = this.settings.translation;
	}

	async resetProviderCaches(): Promise<void> {
		this.provider?.clearCaches();
		this.loadedTranslation = "";
		await this.refreshBooks(true);
	}

	private addAlias(alias: string, canonicalName: string): void {
		const book = this.bookLookup.get(this.normalizeBookName(canonicalName));
		if (book) {
			this.bookLookup.set(this.normalizeBookName(alias), book);
		}
	}

	private async openReferenceFromUri(uri: string): Promise<void> {
		const rawReference = this.parseBibleUri(uri);
		if (!rawReference) {
			new Notice("Invalid bible link.");
			return;
		}
		const parsed = await this.parseReference(rawReference);
		if (!parsed) {
			return;
		}
		await this.openChapterForReference(parsed);
	}

	private parseBibleUri(uri: string): string | null {
		if (!uri.toLowerCase().startsWith("bible:")) {
			return null;
		}
		const encodedReference = uri.replace(/^bible:(\/\/)?/i, "");
		try {
			return decodeURIComponent(encodedReference).trim();
		} catch {
			return encodedReference.trim();
		}
	}

	private async openReferenceFromPrompt(): Promise<void> {
		const initial = "Genesis 1";
		const raw = await this.promptForReference("Open Bible Reference", initial, "", "chapter");
		if (!raw) {
			return;
		}
		const parsed = await this.parseReference(raw);
		if (!parsed) {
			return;
		}
		await this.openChapterForReference(parsed);
	}

	private async insertBibleUriLink(editor: Editor): Promise<void> {
		const from = editor.getCursor("from");
		const to = editor.getCursor("to");
		const selected = editor.getSelection().trim();
		const raw = await this.promptForReference("Insert Bible Link", "Genesis 1 or John 3:16", selected, "link");
		if (!raw) {
			return;
		}
		const parsed = await this.parseReference(raw);
		if (!parsed) {
			return;
		}
		const rendered = this.renderBibleWikiLink(parsed);
		editor.replaceRange(rendered, from, to);
	}

	private async insertPassage(editor: Editor): Promise<void> {
		const from = editor.getCursor("from");
		const to = editor.getCursor("to");
		const selected = editor.getSelection().trim();
		const raw = await this.promptForReference(
			"Insert Bible Passage",
			"Revelation 1:5-11",
			selected,
			"passage"
		);
		if (!raw) {
			return;
		}
		const parsed = await this.parseReference(raw);
		if (!parsed) {
			return;
		}
		if (!parsed.verseStart) {
			new Notice("Use a verse reference (example: Revelation 1:5-11).");
			return;
		}

		const chapterData = await this.getChapter(parsed.bookId, parsed.chapter);
		const verseEnd = parsed.verseEnd ?? parsed.verseStart;
		const selectedVerses = this.collectVerseRange(chapterData, parsed.verseStart, verseEnd);
		if (selectedVerses.length === 0) {
			new Notice("That verse range was not found in this chapter.");
			return;
		}

		const block = this.renderPassageBlock(parsed, selectedVerses);
		editor.replaceRange(block, from, to);
	}

	private async convertBibleCitationAtCursorToLink(editor: Editor): Promise<void> {
		const from = editor.getCursor("from");
		const to = editor.getCursor("to");
		const selected = editor.getSelection().trim();

		if (selected.length > 0) {
			const originalSelection = editor.getSelection();
			const result = await this.convertBibleCitationsInText(originalSelection);
			if (result.replaced === 0) {
				const parsed = await this.parseReference(selected);
				if (!parsed) {
					new Notice("No valid Bible citations found in selection.");
					return;
				}
				const rendered = this.renderBibleWikiLink(parsed);
				editor.replaceRange(rendered, from, to);
				return;
			}
			editor.replaceRange(result.output, from, to);
			new Notice(
				`Converted ${result.replaced} Bible citation${result.replaced === 1 ? "" : "s"} in selection.`
			);
			return;
		}

		const cursor = editor.getCursor();
		const line = editor.getLine(cursor.line);
		const match = await this.findBibleCitationMatchInLine(line, cursor.ch);
		if (!match) {
			new Notice("No Bible citation found at cursor.");
			return;
		}
		const rendered = this.renderBibleWikiLink(match.parsed);
		editor.replaceRange(
			rendered,
			{ line: cursor.line, ch: match.start },
			{ line: cursor.line, ch: match.end }
		);
	}

	private async convertBibleCitationsInText(
		input: string
	): Promise<{ output: string; replaced: number }> {
		const citationPattern =
			/\b((?:[1-3]\s*)?(?:[A-Za-z]{2,}\.?)(?:\s+[A-Za-z]{2,}\.?){0,3})\s*(\d{1,3})(?::(\d{1,3})(?:\s*-\s*(\d{1,3}))?)?\b/g;
		let output = "";
		let cursor = 0;
		let replaced = 0;
		let match: RegExpExecArray | null = null;

		while ((match = citationPattern.exec(input)) !== null) {
			const full = match[0];
			const start = match.index;
			const end = start + full.length;
			output += input.slice(cursor, start);

			if (this.isRangeInsideLinkSyntax(input, start, end)) {
				output += full;
				cursor = end;
				continue;
			}

			const bookToken = match[1].replace(/\s+/g, " ").trim();
			const chapter = match[2];
			const verseStart = match[3];
			const verseEnd = match[4];
			const citation = verseStart
				? `${bookToken} ${chapter}:${verseStart}${verseEnd ? `-${verseEnd}` : ""}`
				: `${bookToken} ${chapter}`;

			const parsed = await this.parseReferenceSilently(citation);
			if (!parsed) {
				output += full;
				cursor = end;
				continue;
			}

			output += this.renderBibleWikiLink(parsed);
			replaced += 1;
			cursor = end;
		}

		output += input.slice(cursor);
		return { output, replaced };
	}

	private async convertBibleLinkAtCursorToQuote(editor: Editor): Promise<void> {
		const selected = editor.getSelection().trim();
		let replaceFrom = editor.getCursor("from");
		let replaceTo = editor.getCursor("to");
		let uri: string | null = null;

		if (selected.length > 0) {
			uri = this.extractBibleUriFromText(selected);
		} else {
			const cursor = editor.getCursor();
			const line = editor.getLine(cursor.line);
			const match = this.findBibleUriMatchInLine(line, cursor.ch);
			if (match) {
				uri = match.uri;
				replaceFrom = { line: cursor.line, ch: match.start };
				replaceTo = { line: cursor.line, ch: match.end };
			}
		}

		if (!uri) {
			new Notice("No bible: link found at cursor.");
			return;
		}

		const rawReference = this.parseBibleUri(uri);
		if (!rawReference) {
			new Notice("Invalid bible link.");
			return;
		}
		const parsed = await this.parseReference(rawReference);
		if (!parsed) {
			return;
		}
		if (!parsed.verseStart) {
			new Notice("Link must include verse reference (example: bible:Genesis1:1-5).");
			return;
		}

		const chapterData = await this.getChapter(parsed.bookId, parsed.chapter);
		const verseEnd = parsed.verseEnd ?? parsed.verseStart;
		const selectedVerses = this.collectVerseRange(chapterData, parsed.verseStart, verseEnd);
		if (selectedVerses.length === 0) {
			new Notice("That verse range was not found in this chapter.");
			return;
		}

		const block = this.renderPassageBlock(parsed, selectedVerses);
		editor.replaceRange(block, replaceFrom, replaceTo);
	}

	private renderBibleWikiLink(reference: ParsedReference): string {
		const label = this.formatReference(reference);
		const uri = this.buildBibleUri(reference);
		return `[[${uri}|${label}]]`;
	}

	private collectVerseRange(
		chapterData: ApiChapterResponse,
		startVerse: number,
		endVerse: number
	): Array<{ verse: number; text: string }> {
		const verses = new Map<number, string>();
		for (const item of chapterData.content) {
			if (item.type !== "verse") {
				continue;
			}
			const verseText = this.renderVerseContent(item.content).replace(/\s+/g, " ").trim();
			verses.set(item.verse, verseText);
		}

		const output: Array<{ verse: number; text: string }> = [];
		for (let verse = startVerse; verse <= endVerse; verse += 1) {
			const text = verses.get(verse);
			if (text) {
				output.push({ verse, text });
			}
		}
		return output;
	}

	private renderPassageBlock(
		parsed: ParsedReference,
		verses: Array<{ verse: number; text: string }>
	): string {
		const header = this.formatReference(parsed);
		const sourceUri = this.buildBibleUri(parsed);
		const lines = [`> [!bible] ${header} (${this.settings.translation.toUpperCase()})`];
		lines.push(`> [[${sourceUri}|${header}]]`);
		for (const verse of verses) {
			lines.push(`> **${verse.verse}** ${verse.text}`);
		}
		lines.push("");
		lines.push(this.chapterReferenceLink(parsed.bookName, parsed.chapter));
		lines.push("");
		return lines.join("\n");
	}

	private chapterReferenceLink(bookName: string, chapter: number): string {
		const label = `${bookName} ${chapter}`;
		return `[[${this.buildBibleUri({ original: label, bookId: "", bookName, chapter })}|${label}]]`;
	}

	private async openChapterForReference(reference: ParsedReference): Promise<void> {
		await this.openChapterReader(reference);
	}

	private async openChapterReader(reference: ParsedReference): Promise<void> {
		const leaf = this.app.workspace.getLeaf(false);
		this.app.workspace.setActiveLeaf(leaf, false, true);
		await leaf.setViewState({
			type: BIBLE_READER_VIEW_TYPE,
			active: true,
			state: {
				reference: this.formatReference(reference),
				bookId: reference.bookId,
				bookName: reference.bookName,
				chapter: reference.chapter,
			},
		});
		this.setActiveReaderReference(reference);
		await this.app.workspace.revealLeaf(leaf);
	}

	private renderVerseContent(content: Array<string | ApiTextFragment>): string {
		const chunks: string[] = [];

		for (const fragment of content) {
			if (typeof fragment === "string") {
				chunks.push(fragment);
				continue;
			}
			if (typeof fragment.text === "string") {
				chunks.push(fragment.text);
			}
			if (typeof fragment.heading === "string") {
				chunks.push(` ${fragment.heading} `);
			}
			if (fragment.lineBreak) {
				chunks.push("\n");
			}
			if (this.settings.includeFootnotes && typeof fragment.noteId === "number") {
				chunks.push(`[${fragment.noteId}]`);
			}
		}

		const joined = chunks.join("");
		const split = joined.split("\n");
		const normalizedLines = split.map((line) => line.replace(/\s+/g, " ").trim());
		return normalizedLines.filter((line) => line.length > 0).join("\n");
	}

	private async getChapter(bookId: string, chapter: number): Promise<ApiChapterResponse> {
		if (!this.provider) {
			throw new Error("Bible provider not initialized.");
		}
		return await this.provider.getChapter(this.settings.translation, bookId, chapter);
	}

	async getChapterByReference(reference: ParsedReference): Promise<ApiChapterResponse> {
		return await this.getChapter(reference.bookId, reference.chapter);
	}

	async parseReferenceForView(raw: string): Promise<ParsedReference | null> {
		return await this.parseReference(raw);
	}

	formatReferencePublic(reference: ParsedReference): string {
		return this.formatReference(reference);
	}

	renderVerseForReader(content: Array<string | ApiTextFragment>): string {
		return this.renderVerseContent(content).replace(/\s+/g, " ").trim();
	}

	async findChapterBacklinksPublic(reference: ParsedReference): Promise<TFile[]> {
		return await this.findChapterBacklinks(reference);
	}

	async openFileInLeaf(file: TFile): Promise<void> {
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file);
	}

	setActiveReaderReference(reference: ParsedReference | null): void {
		this.activeReaderReference = reference;
		void this.refreshBacklinksViews();
	}

	getActiveReaderReference(): ParsedReference | null {
		return this.activeReaderReference;
	}

	async getBooksForBrowser(): Promise<ApiBook[]> {
		await this.refreshBooks();
		return [...this.orderedBooks];
	}

	async openChapterFromBrowser(book: ApiBook, chapter: number): Promise<void> {
		const parsed: ParsedReference = {
			original: `${book.commonName || book.name} ${chapter}`,
			bookId: book.id.toUpperCase(),
			bookName: book.commonName || book.name,
			chapter,
		};
		await this.openChapterForReference(parsed);
	}

	private async refreshBacklinksViews(): Promise<void> {
		const leaves = this.app.workspace.getLeavesOfType(BIBLE_BACKLINKS_VIEW_TYPE);
		for (const leaf of leaves) {
			const view = leaf.view;
			if (view instanceof BibleBacklinksView) {
				await view.refresh();
			}
		}
	}

	private async openBacklinksSidebar(): Promise<void> {
		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) {
			new Notice("Unable to open Bible backlinks sidebar.");
			return;
		}
		await leaf.setViewState({
			type: BIBLE_BACKLINKS_VIEW_TYPE,
			active: true,
		});
		const view = leaf.view;
		if (view instanceof BibleBacklinksView) {
			await view.refresh();
		}
		await this.app.workspace.revealLeaf(leaf);
	}

	private async openBibleBrowserPage(): Promise<void> {
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.setViewState({
			type: BIBLE_BROWSER_VIEW_TYPE,
			active: true,
		});
		const view = leaf.view;
		if (view instanceof BibleBrowserView) {
			await view.refresh();
		}
		await this.app.workspace.revealLeaf(leaf);
	}

	private async promptForStrongsCode(): Promise<string | null> {
		const modal = new ReferenceInputModal(this.app, "Lookup Strong's Code", "G3056 or H7225", "G3056");
		return await modal.waitForResult();
	}

	async lookupStrongsEntry(code: string): Promise<StrongsEntry> {
		const normalized = this.normalizeStrongsCode(code);
		if (!normalized) {
			throw new Error("Invalid Strong's code. Use G#### or H####.");
		}
		const cached = this.strongsCache.get(normalized);
		if (cached) {
			return cached;
		}

		const base = this.settings.strongsApiBaseUrl.trim().replace(/\/+$/, "");
		const candidates = [
			`${base}/strongs/${normalized}.json`,
			`${base}/strong/${normalized}.json`,
			`${base}/lexicon/${normalized}.json`,
			`${base}/${normalized}.json`,
		];

		for (const url of candidates) {
			try {
				const response = await requestUrl({ method: "GET", url });
				if (response.status < 200 || response.status >= 300) {
					continue;
				}
				const entry = this.parseStrongsPayload(response.json, normalized);
				if (!entry) {
					continue;
				}
				this.strongsCache.set(normalized, entry);
				return entry;
			} catch {
				// Try next candidate.
			}
		}

		throw new Error("Strong's entry not found. Check Strongs API base URL in settings.");
	}

	private parseStrongsPayload(payload: unknown, fallbackCode: string): StrongsEntry | null {
		if (!payload || typeof payload !== "object") {
			return null;
		}
		const raw = payload as Record<string, unknown>;
		const code = this.normalizeStrongsCode(
			this.firstNonEmptyString([
				raw.code,
				raw.id,
				raw.strongs,
				raw.strong,
				`${fallbackCode[0]}${raw.number ?? ""}`,
			]) ?? fallbackCode
		);
		if (!code) {
			return null;
		}

		const lemma = this.firstNonEmptyString([raw.lemma, raw.word, raw.original, raw.lexeme, raw.hebrew, raw.greek]);
		const transliteration = this.firstNonEmptyString([
			raw.transliteration,
			raw.translit,
			raw.pronounce,
			raw.pronunciation,
		]);
		const pronunciation = this.firstNonEmptyString([raw.pronunciation, raw.pronounce, raw.phonetic]);
		const definition = this.firstNonEmptyString([
			raw.definition,
			raw.meaning,
			raw.gloss,
			raw.strongsDef,
			raw.strongs_def,
		]);
		const derivation = this.firstNonEmptyString([raw.derivation, raw.origin]);
		const kjvDefinition = this.firstNonEmptyString([raw.kjvDefinition, raw.kjv_def, raw.kjv]);
		const references = this.toStringArray(raw.references ?? raw.verses ?? raw.citations);
		const occurrences =
			typeof raw.occurrences === "number"
				? raw.occurrences
				: typeof raw.count === "number"
					? raw.count
					: references.length > 0
						? references.length
						: undefined;

		if (!lemma && !definition && !kjvDefinition) {
			return null;
		}

		return {
			code,
			lemma,
			transliteration,
			pronunciation,
			definition,
			derivation,
			kjvDefinition,
			occurrences,
			references: references.length > 0 ? references : undefined,
		};
	}

	private firstNonEmptyString(values: unknown[]): string | undefined {
		for (const value of values) {
			if (typeof value === "string" && value.trim().length > 0) {
				return value.trim();
			}
		}
		return undefined;
	}

	private toStringArray(value: unknown): string[] {
		if (!Array.isArray(value)) {
			return [];
		}
		return value
			.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
			.filter((entry) => entry.length > 0);
	}

	private normalizeStrongsCode(input: string): string | null {
		const cleaned = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
		const match = cleaned.match(/^([GH])(\d{1,5})$/);
		if (!match) {
			return null;
		}
		return `${match[1]}${Number.parseInt(match[2], 10)}`;
	}

	private async openStrongsSidebar(code: string): Promise<void> {
		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) {
			new Notice("Unable to open Strong's sidebar.");
			return;
		}
		await leaf.setViewState({
			type: BIBLE_STRONGS_VIEW_TYPE,
			active: true,
			state: { code },
		});
		const view = leaf.view;
		if (view instanceof BibleStrongsView) {
			await view.setCode(code);
		}
		await this.app.workspace.revealLeaf(leaf);
	}

	private async findChapterBacklinks(reference: ParsedReference): Promise<TFile[]> {
		const files = this.app.vault.getMarkdownFiles();
		const chapterLabel = `${reference.bookName} ${reference.chapter}`;
		const encodedLabel = encodeURIComponent(chapterLabel);
		const chapterUri = this.buildBibleUri({
			...reference,
			verseStart: undefined,
			verseEnd: undefined,
		});

		const patterns = [
			new RegExp(`bible:\\/\\/${this.escapeRegex(chapterLabel)}(?:\\b|%20|%3A|\\)|\\])`, "i"),
			new RegExp(`bible:\\/\\/${this.escapeRegex(encodedLabel)}(?:\\b|\\)|\\])`, "i"),
			new RegExp(`${this.escapeRegex(chapterUri)}(?:\\b|:\\d+(?:-\\d+)?)`, "i"),
		];

		const matches = await Promise.all(
			files.map(async (file) => {
				const body = await this.app.vault.cachedRead(file);
				if (patterns.some((pattern) => pattern.test(body))) {
					return file;
				}
				return null;
			})
		);

		return matches.filter((file): file is TFile => file !== null);
	}

	private async parseReference(rawReference: string): Promise<ParsedReference | null> {
		return await this.parseReferenceInternal(rawReference, true);
	}

	private async parseReferenceSilently(rawReference: string): Promise<ParsedReference | null> {
		return await this.parseReferenceInternal(rawReference, false);
	}

	private async parseReferenceInternal(
		rawReference: string,
		emitNotices: boolean
	): Promise<ParsedReference | null> {
		await this.refreshBooks();

		const raw = rawReference
			.replace(/^bible:(\/\/)?/i, "")
			.replace(/[\\/]+/g, " ")
			.trim();
		const match =
			raw.match(/^(.+?)\s+(\d+)(?::(\d+)(?:\s*-\s*(\d+))?)?$/i) ||
			raw.match(/^(.+?)(\d+)(?::(\d+)(?:\s*-\s*(\d+))?)?$/i);
		if (!match) {
			if (emitNotices) {
				new Notice("Invalid reference. Use format like Genesis 1 or Revelation 1:5-11.");
			}
			return null;
		}

		const bookInput = match[1].trim();
		const chapter = Number.parseInt(match[2], 10);
		const verseStart = match[3] ? Number.parseInt(match[3], 10) : undefined;
		const verseEnd = match[4] ? Number.parseInt(match[4], 10) : undefined;

		if (!Number.isInteger(chapter) || chapter < 1) {
			if (emitNotices) {
				new Notice("Chapter must be 1 or greater.");
			}
			return null;
		}
		if (verseStart !== undefined && (!Number.isInteger(verseStart) || verseStart < 1)) {
			if (emitNotices) {
				new Notice("Verse must be 1 or greater.");
			}
			return null;
		}
		if (
			verseStart !== undefined &&
			verseEnd !== undefined &&
			(!Number.isInteger(verseEnd) || verseEnd < verseStart)
		) {
			if (emitNotices) {
				new Notice("Verse range is invalid.");
			}
			return null;
		}

		const book = this.resolveBook(bookInput);
		if (!book) {
			if (emitNotices) {
				new Notice(`Book not recognized: ${bookInput}`);
			}
			return null;
		}

		return {
			original: rawReference,
			bookId: book.id.toUpperCase(),
			bookName: book.commonName || book.name,
			chapter,
			verseStart,
			verseEnd: verseStart !== undefined ? verseEnd ?? verseStart : undefined,
		};
	}

	private resolveBook(bookInput: string): ApiBook | null {
		const normalizedInput = this.normalizeBookName(bookInput);
		const variants = this.bookNameVariants(normalizedInput);

		for (const variant of variants) {
			const book = this.bookLookup.get(variant);
			if (book) {
				return book;
			}
		}

		const abbreviated = this.resolveAbbreviatedBook(normalizedInput);
		if (abbreviated) {
			return abbreviated;
		}
		return null;
	}

	private resolveAbbreviatedBook(normalizedInput: string): ApiBook | null {
		const compactInput = normalizedInput.replace(/\s+/g, "");
		if (compactInput.length < 2) {
			return null;
		}

		const lettersOnly = compactInput.replace(/[0-9]/g, "");
		const hasLeadingNumber = /^\d/.test(compactInput);
		const minLetters = hasLeadingNumber ? 2 : 3;
		if (lettersOnly.length < minLetters) {
			return null;
		}

		const matched = new Map<string, ApiBook>();
		for (const [key, book] of this.bookLookup.entries()) {
			const compactKey = key.replace(/\s+/g, "");
			if (compactKey.startsWith(compactInput)) {
				matched.set(book.id.toUpperCase(), book);
			}
		}

		if (matched.size === 1) {
			return [...matched.values()][0];
		}
		return null;
	}

	private bookNameVariants(normalizedInput: string): string[] {
		const variants = new Set<string>();
		variants.add(normalizedInput);
		if (normalizedInput.endsWith("s")) {
			variants.add(normalizedInput.slice(0, -1));
		}

		const firstToNumber = normalizedInput
			.replace(/^first\s+/, "1 ")
			.replace(/^second\s+/, "2 ")
			.replace(/^third\s+/, "3 ")
			.replace(/^i+\s+/, (match) => {
				const roman = match.trim().toUpperCase();
				if (roman === "I") {
					return "1 ";
				}
				if (roman === "II") {
					return "2 ";
				}
				if (roman === "III") {
					return "3 ";
				}
				return match;
			});
		variants.add(firstToNumber);

		const numberToWord = normalizedInput
			.replace(/^1\s+/, "first ")
			.replace(/^2\s+/, "second ")
			.replace(/^3\s+/, "third ");
		variants.add(numberToWord);

		return [...variants].map((entry) => entry.trim()).filter((entry) => entry.length > 0);
	}

	private normalizeBookName(input: string): string {
		return input
			.toLowerCase()
			.replace(/^([123ivx]+)([a-z])/, "$1 $2")
			.replace(/&/g, " and ")
			.replace(/[^a-z0-9\s]/g, " ")
			.replace(/\s+/g, " ")
			.trim();
	}

	private escapeRegex(input: string): string {
		return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}

	private formatReference(reference: ParsedReference): string {
		const base = `${reference.bookName} ${reference.chapter}`;
		if (reference.verseStart === undefined) {
			return base;
		}
		if (reference.verseEnd !== undefined && reference.verseEnd !== reference.verseStart) {
			return `${base}:${reference.verseStart}-${reference.verseEnd}`;
		}
		return `${base}:${reference.verseStart}`;
	}

	private buildBibleUri(reference: ParsedReference): string {
		const compactBook = reference.bookName.replace(/[^A-Za-z0-9]/g, "");
		const chapterPart = `${compactBook}${reference.chapter}`;
		if (reference.verseStart === undefined) {
			return `bible:${chapterPart}`;
		}
		if (reference.verseEnd !== undefined && reference.verseEnd !== reference.verseStart) {
			return `bible:${chapterPart}:${reference.verseStart}-${reference.verseEnd}`;
		}
		return `bible:${chapterPart}:${reference.verseStart}`;
	}

	private async promptForReference(
		title: string,
		placeholder: string,
		initialValue = "",
		mode: ReferencePromptMode = "chapter"
	): Promise<string | null> {
		await this.refreshBooks();
		const modal = new ReferenceInputModal(
			this.app,
			title,
			placeholder,
			initialValue,
			(query) => this.getReferenceSuggestions(query, mode)
		);
		return await modal.waitForResult();
	}

	private async convertLegacyLinksInActiveFile(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice("No active file.");
			return;
		}

		const original = await this.app.vault.cachedRead(file);
		const result = await this.convertMarkdownBibleLinksInText(original);
		if (result.replaced === 0) {
			new Notice("No Markdown Bible links found.");
			return;
		}

		await this.app.vault.modify(file, result.output);
		new Notice(
			`Converted ${result.replaced} Markdown Bible link(s) in ${file.basename}${
				result.skipped > 0 ? ` (${result.skipped} skipped)` : ""
			}.`
		);
	}

	private async convertLegacyLinksInVault(): Promise<void> {
		const files = this.app.vault.getMarkdownFiles();
		let changedFiles = 0;
		let replaced = 0;
		let skipped = 0;

		for (const file of files) {
			const original = await this.app.vault.cachedRead(file);
			const result = await this.convertMarkdownBibleLinksInText(original);
			if (result.replaced > 0) {
				await this.app.vault.modify(file, result.output);
				changedFiles += 1;
				replaced += result.replaced;
			}
			skipped += result.skipped;
		}

		if (replaced === 0) {
			new Notice("No Markdown Bible links found in vault.");
			return;
		}
		new Notice(
			`Converted ${replaced} Markdown Bible link(s) across ${changedFiles} file(s)${
				skipped > 0 ? ` (${skipped} skipped)` : ""
			}.`
		);
	}

	private async convertMarkdownBibleLinksInText(
		input: string
	): Promise<{ output: string; replaced: number; skipped: number }> {
		let working = input;
		let replaced = 0;
		let skipped = 0;

		const legacyAnchorPattern = /\[([^\]]+)\]\(([^)]+)\)(?:-(\d{1,3}))?/gi;
		let output = "";
		let cursor = 0;
		let match: RegExpExecArray | null = null;

		while ((match = legacyAnchorPattern.exec(working)) !== null) {
			const [fullMatch, _label, href, trailingVerseEnd] = match;
			output += working.slice(cursor, match.index);

			const parsed = await this.parseLegacyMarkdownHrefToReference(href, trailingVerseEnd);
			if (!parsed) {
				output += fullMatch;
				cursor = match.index + fullMatch.length;
				continue;
			}

			output += this.renderBibleWikiLink(parsed);
			replaced += 1;
			cursor = match.index + fullMatch.length;
		}
		output += working.slice(cursor);
		working = output;

		const markdownBiblePattern = /\[([^\]]+)\]\((bible:(?:\/\/)?[^)]+)\)/gi;
		output = "";
		cursor = 0;
		match = null;
		while ((match = markdownBiblePattern.exec(working)) !== null) {
			const [fullMatch, label, uri] = match;
			output += working.slice(cursor, match.index);

			const rawReference = this.parseBibleUri(uri);
			if (!rawReference) {
				output += fullMatch;
				cursor = match.index + fullMatch.length;
				continue;
			}
			const parsed = await this.parseReferenceSilently(rawReference);
			if (parsed) {
				output += this.renderBibleWikiLink(parsed);
				replaced += 1;
			} else {
				const safeLabel = label.trim() || uri;
				output += `[[${uri}|${safeLabel}]]`;
				replaced += 1;
			}
			cursor = match.index + fullMatch.length;
		}

		output += working.slice(cursor);
		working = output;

		const wikiBiblePattern = /\[\[(bible:(?:\/\/)?[^\]|]+)(?:\|([^\]]+))?\]\]/gi;
		output = "";
		cursor = 0;
		match = null;
		while ((match = wikiBiblePattern.exec(working)) !== null) {
			const [fullMatch, uri, alias] = match;
			output += working.slice(cursor, match.index);

			const rawReference = this.parseBibleUri(uri);
			if (!rawReference) {
				output += fullMatch;
				cursor = match.index + fullMatch.length;
				continue;
			}
			const parsed = await this.parseReferenceSilently(rawReference);
			if (!parsed) {
				output += fullMatch;
				cursor = match.index + fullMatch.length;
				continue;
			}
			const canonical = this.renderBibleWikiLink(parsed);
			if (canonical !== fullMatch) {
				replaced += 1;
			} else if (alias && alias !== this.formatReference(parsed)) {
				replaced += 1;
			}
			output += canonical;
			cursor = match.index + fullMatch.length;
		}

		output += working.slice(cursor);
		return { output, replaced, skipped };
	}

	private async parseLegacyMarkdownHrefToReference(
		href: string,
		trailingVerseEnd?: string
	): Promise<ParsedReference | null> {
		const verseStyleMatch = href.match(/^([1-3]?[A-Za-z]+)-(\d{1,3})#v(\d{1,3})(?:-(\d{1,3}))?$/i);
		if (verseStyleMatch) {
			const bookToken = verseStyleMatch[1];
			const chapter = Number.parseInt(verseStyleMatch[2], 10);
			const verseStart = Number.parseInt(verseStyleMatch[3], 10);
			const verseEnd =
				verseStyleMatch[4] !== undefined
					? Number.parseInt(verseStyleMatch[4], 10)
					: trailingVerseEnd !== undefined
						? Number.parseInt(trailingVerseEnd, 10)
						: undefined;

			const rawReference =
				verseEnd !== undefined
					? `${bookToken} ${chapter}:${verseStart}-${verseEnd}`
					: `${bookToken} ${chapter}:${verseStart}`;
			return await this.parseReferenceSilently(rawReference);
		}

		const chapterStyleMatch = href.match(/^([1-3]?[A-Za-z]+)-(\d{1,3})$/i);
		if (chapterStyleMatch) {
			const bookToken = chapterStyleMatch[1];
			const chapter = Number.parseInt(chapterStyleMatch[2], 10);
			return await this.parseReferenceSilently(`${bookToken} ${chapter}`);
		}

		return null;
	}

	private async removeLegacyGraphSectionInActiveFile(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice("No active file.");
			return;
		}
		const original = await this.app.vault.cachedRead(file);
		const { output, hadSection } = this.stripLegacyGraphSection(original);
		if (!hadSection) {
			new Notice("No legacy BSB graph section found.");
			return;
		}
		await this.app.vault.modify(file, output);
		new Notice(`Removed legacy BSB graph section in ${file.basename}.`);
	}

	private async removeLegacyGraphSectionInVault(): Promise<void> {
		const files = this.app.vault.getMarkdownFiles();
		let updatedFiles = 0;
		for (const file of files) {
			const original = await this.app.vault.cachedRead(file);
			const { output, hadSection } = this.stripLegacyGraphSection(original);
			if (hadSection) {
				await this.app.vault.modify(file, output);
				updatedFiles += 1;
			}
		}
		if (updatedFiles === 0) {
			new Notice("No legacy BSB graph sections found in vault.");
			return;
		}
		new Notice(`Removed legacy BSB graph sections in ${updatedFiles} file(s).`);
	}

	private stripLegacyGraphSection(input: string): { output: string; hadSection: boolean } {
		const escapedStart = this.escapeRegex(BIBLE_GRAPH_START);
		const escapedEnd = this.escapeRegex(BIBLE_GRAPH_END);
		const pattern = new RegExp(`${escapedStart}[\\s\\S]*?${escapedEnd}\\n?`, "g");
		const hadSection = pattern.test(input);
		pattern.lastIndex = 0;
		const output = input.replace(pattern, "").replace(/\n{3,}$/g, "\n\n");
		return { output, hadSection };
	}

	private getReferenceSuggestions(query: string, mode: ReferencePromptMode): string[] {
		const input = query.replace(/^bible:(\/\/)?/i, "").trim();
		const books = this.orderedBooks.length > 0 ? this.orderedBooks : [...this.bookById.values()];
		if (books.length === 0) {
			return [];
		}

		const parsed = this.parseLooseReference(input);
		const bookQuery = parsed.bookQuery.trim();
		const matchingBooks = this.findBooksForSuggestions(bookQuery, books).slice(0, 8);
		const targetBooks = matchingBooks.length > 0 ? matchingBooks : books.slice(0, 8);
		const suggestions: Array<{ value: string; bookOrder: number; insertionOrder: number }> = [];
		let insertionOrder = 0;
		const addSuggestion = (value: string, bookOrder: number): void => {
			suggestions.push({ value, bookOrder, insertionOrder });
			insertionOrder += 1;
		};

		for (const [bookOrder, book] of targetBooks.entries()) {
			const name = book.commonName || book.name;
			const maxChapter = book.chapterCount && book.chapterCount > 0 ? book.chapterCount : 150;
			const chapter = Math.max(1, Math.min(parsed.chapter ?? 1, maxChapter));

			if (mode === "chapter") {
				addSuggestion(`${name} ${chapter}`, bookOrder);
				if (chapter + 1 <= maxChapter) {
					addSuggestion(`${name} ${chapter + 1}`, bookOrder);
				}
				continue;
			}

			if (parsed.chapter === undefined) {
				addSuggestion(`${name} 1`, bookOrder);
				addSuggestion(`${name} 1:1`, bookOrder);
				continue;
			}

			if (parsed.verseStart === undefined) {
				addSuggestion(`${name} ${chapter}`, bookOrder);
				addSuggestion(`${name} ${chapter}:1`, bookOrder);
				continue;
			}

			const start = Math.max(1, parsed.verseStart);
			addSuggestion(`${name} ${chapter}:${start}`, bookOrder);
			if (parsed.verseEnd !== undefined) {
				addSuggestion(`${name} ${chapter}:${start}-${Math.max(start, parsed.verseEnd)}`, bookOrder);
			}
		}

		const unique = new Map<string, { value: string; score: number; bookOrder: number; insertionOrder: number }>();
		for (const suggestion of suggestions) {
			const key = this.normalizeSuggestionValue(suggestion.value);
			const score = this.scoreReferenceSuggestion(input, parsed, suggestion.value);
			const existing = unique.get(key);
			if (
				!existing ||
				score > existing.score ||
				(score === existing.score && suggestion.insertionOrder < existing.insertionOrder)
			) {
				unique.set(key, {
					value: suggestion.value,
					score,
					bookOrder: suggestion.bookOrder,
					insertionOrder: suggestion.insertionOrder,
				});
			}
		}
		return [...unique.values()]
			.sort((a, b) => {
				if (a.score !== b.score) {
					return b.score - a.score;
				}
				if (a.bookOrder !== b.bookOrder) {
					return a.bookOrder - b.bookOrder;
				}
				return a.insertionOrder - b.insertionOrder;
			})
			.slice(0, 12)
			.map((item) => item.value);
	}

	private scoreReferenceSuggestion(
		input: string,
		parsedInput: { bookQuery: string; chapter?: number; verseStart?: number; verseEnd?: number },
		suggestion: string
	): number {
		const normalizedInput = this.normalizeSuggestionValue(input);
		const normalizedSuggestion = this.normalizeSuggestionValue(suggestion);
		if (normalizedInput.length === 0) {
			return 0;
		}

		let score = 0;
		if (normalizedSuggestion === normalizedInput) {
			score += 1000;
		} else if (normalizedSuggestion.startsWith(normalizedInput)) {
			score += 700;
		} else if (normalizedSuggestion.includes(normalizedInput)) {
			score += 450;
		}

		const parsedSuggestion = this.parseLooseReference(suggestion);
		const normalizedInputBook = this.normalizeBookName(parsedInput.bookQuery).replace(/\s+/g, "");
		const normalizedSuggestionBook = this.normalizeBookName(parsedSuggestion.bookQuery).replace(/\s+/g, "");
		if (normalizedInputBook.length > 0) {
			if (normalizedSuggestionBook === normalizedInputBook) {
				score += 220;
			} else if (normalizedSuggestionBook.startsWith(normalizedInputBook)) {
				score += 120;
			} else if (normalizedSuggestionBook.includes(normalizedInputBook)) {
				score += 60;
			} else {
				score -= 80;
			}
		}

		if (parsedInput.chapter !== undefined) {
			if (parsedSuggestion.chapter === parsedInput.chapter) {
				score += 160;
			} else {
				score -= 40;
			}
		}

		if (parsedInput.verseStart !== undefined) {
			if (parsedSuggestion.verseStart === parsedInput.verseStart) {
				score += 130;
			} else if (parsedSuggestion.verseStart !== undefined) {
				score -= 30;
			}
		}

		if (parsedInput.verseEnd !== undefined) {
			if (parsedSuggestion.verseEnd === parsedInput.verseEnd) {
				score += 100;
			} else if (parsedSuggestion.verseEnd === undefined) {
				score -= 40;
			}
		}

		score -= Math.abs(normalizedSuggestion.length - normalizedInput.length);
		return score;
	}

	private normalizeSuggestionValue(value: string): string {
		return value
			.toLowerCase()
			.replace(/^bible:(\/\/)?/i, "")
			.replace(/\s+/g, " ")
			.trim();
	}

	private parseLooseReference(input: string): {
		bookQuery: string;
		chapter?: number;
		verseStart?: number;
		verseEnd?: number;
	} {
		const value = input.trim();
		if (value.length === 0) {
			return { bookQuery: "" };
		}

		const verseSplit = value.split(":");
		const left = verseSplit[0].trim();
		const versePart = verseSplit.length > 1 ? verseSplit.slice(1).join(":").trim() : "";

		let bookQuery = left;
		let chapter: number | undefined;

		const spacedChapterMatch = left.match(/^(.+?)\s+(\d+)$/);
		if (spacedChapterMatch) {
			bookQuery = spacedChapterMatch[1].trim();
			chapter = Number.parseInt(spacedChapterMatch[2], 10);
		} else {
			const compactChapterMatch = left.match(/^(.+?)(\d+)$/);
			if (compactChapterMatch) {
				bookQuery = compactChapterMatch[1].trim();
				chapter = Number.parseInt(compactChapterMatch[2], 10);
			}
		}

		let verseStart: number | undefined;
		let verseEnd: number | undefined;
		if (versePart.length > 0) {
			const rangeMatch = versePart.match(/^(\d+)?(?:\s*-\s*(\d+)?)?$/);
			if (rangeMatch) {
				if (rangeMatch[1]) {
					verseStart = Number.parseInt(rangeMatch[1], 10);
				}
				if (rangeMatch[2]) {
					verseEnd = Number.parseInt(rangeMatch[2], 10);
				}
			}
		}

		return { bookQuery, chapter, verseStart, verseEnd };
	}

	private findBooksForSuggestions(query: string, books: ApiBook[]): ApiBook[] {
		if (!query) {
			return books.slice(0, 12);
		}

		const normalizedQuery = this.normalizeBookName(query).replace(/\s+/g, "");
		const startsWith: ApiBook[] = [];
		const includes: ApiBook[] = [];

		for (const book of books) {
			const names = [book.name, book.commonName, book.title]
				.filter((name): name is string => Boolean(name))
				.map((name) => this.normalizeBookName(name).replace(/\s+/g, ""));
			if (names.some((name) => name.startsWith(normalizedQuery))) {
				startsWith.push(book);
			} else if (names.some((name) => name.includes(normalizedQuery))) {
				includes.push(book);
			}
		}

		return [...startsWith, ...includes];
	}

	private getActiveEditor(): Editor | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			return null;
		}
		return view.editor ?? null;
	}

	private registerBibleLinkHandlersForWindow(win: Window): void {
		const doc = win.document;
		this.registerDomEvent(
			doc,
			"click",
			(event: MouseEvent) => {
				this.handleBibleLinkMouseEvent(event);
			},
			{ capture: true }
		);
		this.registerDomEvent(
			doc,
			"auxclick",
			(event: MouseEvent) => {
				this.handleBibleLinkMouseEvent(event);
			},
			{ capture: true }
		);
	}

	private handleBibleLinkMouseEvent(event: MouseEvent): void {
		const rawTarget = event.target;
		const target =
			rawTarget instanceof HTMLElement
				? rawTarget
				: rawTarget instanceof Text
					? rawTarget.parentElement
					: null;
		if (!target) {
			return;
		}

		const selection = target.ownerDocument?.getSelection();
		if (selection && !selection.isCollapsed) {
			return;
		}

		const href = this.extractBibleHref(event, target);
		if (!href) {
			return;
		}

		const inSourceView = Boolean(target.closest(".markdown-source-view"));
		if (inSourceView && !Keymap.isModEvent(event) && event.type !== "click") {
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		if (typeof event.stopImmediatePropagation === "function") {
			event.stopImmediatePropagation();
		}

		void this.runWithErrorNotice(() => this.openReferenceFromUri(href));
	}

	private extractBibleHref(event: MouseEvent, target: HTMLElement): string | null {
		const path = typeof event.composedPath === "function" ? event.composedPath() : [target];
		let hasLinkContext = false;
		for (const node of path) {
			if (!(node instanceof HTMLElement)) {
				continue;
			}
			const href = node.getAttribute("href");
			if (href && href.toLowerCase().startsWith("bible:")) {
				return href;
			}
			const dataHref = node.getAttribute("data-href");
			if (dataHref && dataHref.toLowerCase().startsWith("bible:")) {
				return dataHref;
			}
			if (
				node.matches(
					"a, .external-link, .cm-link, .cm-url, .cm-hmd-external-link, .cm-formatting-link, .cm-hmd-barelink, .cm-string.cm-url"
				)
			) {
				hasLinkContext = true;
			}
		}
		if (!hasLinkContext) {
			return null;
		}

		const cmUri = this.extractBibleHrefFromEditorView(event, target);
		if (cmUri) {
			return cmUri;
		}
		return null;
	}

	private extractBibleHrefFromEditorView(event: MouseEvent, target: HTMLElement): string | null {
		const cmHost = target.closest(".cm-editor") as HTMLElement | null;
		if (!cmHost) {
			return null;
		}
		const cmView = EditorView.findFromDOM(cmHost);
		if (!cmView) {
			return null;
		}
		const pos = cmView.posAtCoords({ x: event.clientX, y: event.clientY });
		if (pos == null) {
			return null;
		}
		const line = cmView.state.doc.lineAt(pos);
		const offset = pos - line.from;
		return this.findBibleUriInLine(line.text, offset);
	}

	private findBibleUriInLine(line: string, offset?: number): string | null {
		return this.findBibleUriMatchInLine(line, offset)?.uri ?? null;
	}

	private findBibleUriMatchInLine(line: string, offset?: number): BibleUriMatch | null {
		const patterns = [
			/\[\[[^\]|]+\|\s*(bible:(?:\/\/)?[^\]]+)\]\]/gi,
			/\[[^\]]*]\((bible:(?:\/\/)?[^)]+)\)/gi,
			/\b(bible:(?:\/\/)?[^\s)\]]+)/gi,
		];

		for (const pattern of patterns) {
			pattern.lastIndex = 0;
			let match: RegExpExecArray | null = null;
			while ((match = pattern.exec(line)) !== null) {
				const fullStart = match.index;
				const fullEnd = fullStart + match[0].length;
				const uri = match[1]?.trim().replace(/[.,;!?]+$/, "");
				if (!uri) {
					continue;
				}
				if (offset === undefined || (offset >= fullStart && offset <= fullEnd)) {
					return { uri, start: fullStart, end: fullEnd };
				}
			}
		}
		return null;
	}

	private extractBibleUriFromText(input: string): string | null {
		const trimmed = input.trim();
		if (!trimmed) {
			return null;
		}
		if (trimmed.toLowerCase().startsWith("bible:")) {
			const bare = trimmed.match(/^(bible:(?:\/\/)?[^\s)\]]+)/i);
			return bare ? bare[1].trim().replace(/[.,;!?]+$/, "") : null;
		}
		return this.findBibleUriMatchInLine(trimmed)?.uri ?? null;
	}

	private async findBibleCitationMatchInLine(
		line: string,
		offset?: number
	): Promise<BibleCitationMatch | null> {
		const patterns = [
			/\b((?:[1-3]\s*)?(?:[A-Za-z]{2,}\.?)(?:\s+[A-Za-z]{2,}\.?){0,3})\s+(\d{1,3})(?::(\d{1,3})(?:\s*-\s*(\d{1,3}))?)?\b/g,
			/\b((?:[1-3]\s*)?[A-Za-z]{2,}\.?)(\d{1,3})(?::(\d{1,3})(?:\s*-\s*(\d{1,3}))?)?\b/g,
		];

		for (const pattern of patterns) {
			pattern.lastIndex = 0;
			let match: RegExpExecArray | null = null;
			while ((match = pattern.exec(line)) !== null) {
				const fullStart = match.index;
				const fullEnd = fullStart + match[0].length;
				if (offset !== undefined && (offset < fullStart || offset > fullEnd)) {
					continue;
				}
				if (this.isRangeInsideLinkSyntax(line, fullStart, fullEnd)) {
					continue;
				}

				const bookToken = match[1].replace(/\s+/g, " ").trim();
				const chapter = match[2];
				const verseStart = match[3];
				const verseEnd = match[4];
				const citation = verseStart
					? `${bookToken} ${chapter}:${verseStart}${verseEnd ? `-${verseEnd}` : ""}`
					: `${bookToken} ${chapter}`;
				const parsed = await this.parseReferenceSilently(citation);
				if (!parsed) {
					continue;
				}

				return {
					start: fullStart,
					end: fullEnd,
					parsed,
				};
			}
		}
		return null;
	}

	private isRangeInsideLinkSyntax(line: string, start: number, end: number): boolean {
		const patterns = [/\[[^\]]*]\([^)]+\)/g, /\[\[[^\]]+]]/g];
		for (const pattern of patterns) {
			pattern.lastIndex = 0;
			let match: RegExpExecArray | null = null;
			while ((match = pattern.exec(line)) !== null) {
				const linkStart = match.index;
				const linkEnd = linkStart + match[0].length;
				if (start >= linkStart && end <= linkEnd) {
					return true;
				}
			}
		}
		return false;
	}

	private decorateBibleProtocolLinks(root: HTMLElement): void {
		const links = root.querySelectorAll("a[href^='bible:'], a[data-href^='bible:']");
		links.forEach((linkNode) => {
			const link = linkNode as HTMLAnchorElement;
			const href = link.getAttribute("href") ?? link.getAttribute("data-href");
			if (!href) {
				return;
			}

			link.addEventListener(
				"click",
				(event) => {
					event.preventDefault();
					event.stopPropagation();
					void this.runWithErrorNotice(() => this.openReferenceFromUri(href));
				},
				{ capture: true }
			);
			link.addEventListener(
				"auxclick",
				(event) => {
					event.preventDefault();
					event.stopPropagation();
					void this.runWithErrorNotice(() => this.openReferenceFromUri(href));
				},
				{ capture: true }
			);
		});
	}

	private async runWithErrorNotice(action: () => Promise<void>): Promise<void> {
		try {
			await action();
		} catch (error) {
			console.error("[BSB Browser] Action failed", error);
			const message = error instanceof Error ? error.message : "Unknown error";
			new Notice(`Bible action failed: ${message}`);
		}
	}
}

interface BibleReaderState {
	reference?: string;
	bookId?: string;
	bookName?: string;
	chapter?: number;
}

interface BibleBrowserState {
	selectedBookId?: string;
}

interface BibleStrongsState {
	code?: string;
}

class BibleReaderView extends FileView {
	private reference: ParsedReference | null = null;

	constructor(leaf: WorkspaceLeaf, private readonly plugin: BereanStandardBibleBrowser) {
		super(leaf);
		this.allowNoFile = true;
	}

	getViewType(): string {
		return BIBLE_READER_VIEW_TYPE;
	}

	getDisplayText(): string {
		if (!this.reference) {
			return "Bible Reader";
		}
		return `Bible: ${this.reference.bookName} ${this.reference.chapter}`;
	}

	getIcon(): "book-open" {
		return "book-open";
	}

	async onOpen(): Promise<void> {
		await this.render();
	}

	getState(): Record<string, unknown> {
		if (!this.reference) {
			return {};
		}
		return {
			reference: this.plugin.formatReferencePublic(this.reference),
			bookId: this.reference.bookId,
			bookName: this.reference.bookName,
			chapter: this.reference.chapter,
		};
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		await super.setState(state, result);

		const next = (state && typeof state === "object" ? state : {}) as BibleReaderState;
		if (
			typeof next.bookId === "string" &&
			typeof next.bookName === "string" &&
			typeof next.chapter === "number"
		) {
			this.reference = {
				original: next.reference ?? `${next.bookName} ${next.chapter}`,
				bookId: next.bookId,
				bookName: next.bookName,
				chapter: next.chapter,
			};
		} else if (typeof next.reference === "string") {
			this.reference = await this.plugin.parseReferenceForView(next.reference);
		} else {
			this.reference = null;
		}

		this.plugin.setActiveReaderReference(this.reference);
		await this.render();
	}

	private async render(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("bible-reader-view");

		if (!this.reference) {
			this.contentEl.createEl("p", { text: "Open a bible: link to read a chapter." });
			return;
		}

		try {
			const chapterData = await this.plugin.getChapterByReference(this.reference);
			const backlinks = await this.plugin.findChapterBacklinksPublic(this.reference);
			const heading = this.contentEl.createEl("h1", {
				text: `${this.reference.bookName} ${this.reference.chapter}`,
			});
			heading.style.marginBottom = "0.2rem";
			this.contentEl.createEl("p", {
				text: `Berean Standard Bible (${this.plugin.settings.translation.toUpperCase()})`,
			});

			const contentEl = this.contentEl.createDiv();
			contentEl.style.maxWidth = "76ch";
			contentEl.style.lineHeight = "1.75";

			for (const item of chapterData.content) {
				if (item.type === "heading") {
					contentEl.createEl("h2", { text: item.content.trim() });
					continue;
				}
				if (item.type === "hebrew_subtitle") {
					contentEl.createEl("p", { text: item.content.trim() }).style.fontStyle = "italic";
					continue;
				}
				if (item.type === "line_break") {
					contentEl.createEl("br");
					continue;
				}

				const verse = contentEl.createEl("p");
				verse.createEl("strong", { text: `${item.verse} ` });
				verse.appendText(this.plugin.renderVerseForReader(item.content));
			}

			const backlinksTitle = this.contentEl.createEl("h2", { text: "Backlinks" });
			backlinksTitle.style.marginTop = "1.5rem";
			if (backlinks.length === 0) {
				this.contentEl.createEl("p", { text: "No backlinks found for this chapter yet." });
				return;
			}

			const list = this.contentEl.createEl("ul");
			for (const file of backlinks.slice(0, 150)) {
				const item = list.createEl("li");
				const link = item.createEl("a", { href: "#", text: file.path });
				link.addEventListener("click", (event) => {
					event.preventDefault();
					void this.plugin.openFileInLeaf(file);
				});
			}
		} catch (error) {
			console.error("[BSB Browser] Reader render failed", error);
			const message = error instanceof Error ? error.message : "Unknown error";
			this.contentEl.createEl("p", { text: `Failed to load chapter: ${message}` });
		}
	}
}

class BibleBacklinksView extends ItemView {
	constructor(leaf: WorkspaceLeaf, private readonly plugin: BereanStandardBibleBrowser) {
		super(leaf);
	}

	getViewType(): string {
		return BIBLE_BACKLINKS_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Bible Backlinks";
	}

	getIcon(): string {
		return "links-coming-in";
	}

	async onOpen(): Promise<void> {
		await this.refresh();
	}

	async refresh(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();

		const reference = this.plugin.getActiveReaderReference();
		if (!reference) {
			contentEl.createEl("p", { text: "Open a Bible chapter to view backlinks." });
			return;
		}

		contentEl.createEl("h3", {
			text: `Backlinks: ${this.plugin.formatReferencePublic(reference)}`,
		});
		const backlinks = await this.plugin.findChapterBacklinksPublic(reference);
		if (backlinks.length === 0) {
			contentEl.createEl("p", { text: "No backlinks found for this chapter yet." });
			return;
		}

		const list = contentEl.createEl("ul");
		for (const file of backlinks.slice(0, 300)) {
			const item = list.createEl("li");
			const link = item.createEl("a", { href: "#", text: file.path });
			link.addEventListener("click", (event) => {
				event.preventDefault();
				void this.plugin.openFileInLeaf(file);
			});
		}
	}
}

class BibleBrowserView extends ItemView {
	private selectedBookId: string | null = null;

	constructor(leaf: WorkspaceLeaf, private readonly plugin: BereanStandardBibleBrowser) {
		super(leaf);
	}

	getViewType(): string {
		return BIBLE_BROWSER_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Bible Browser";
	}

	getIcon(): string {
		return "library";
	}

	getState(): Record<string, unknown> {
		return this.selectedBookId ? { selectedBookId: this.selectedBookId } : {};
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		await super.setState(state, result);
		const next = (state && typeof state === "object" ? state : {}) as BibleBrowserState;
		this.selectedBookId = typeof next.selectedBookId === "string" ? next.selectedBookId : null;
		await this.refresh();
	}

	async onOpen(): Promise<void> {
		await this.refresh();
	}

	async refresh(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("bible-browser-view");

		const books = await this.plugin.getBooksForBrowser();
		if (books.length === 0) {
			contentEl.createEl("p", { text: "No Bible books available." });
			return;
		}

		const selected =
			(this.selectedBookId && books.find((book) => book.id.toUpperCase() === this.selectedBookId)) || books[0];
		this.selectedBookId = selected.id.toUpperCase();

		contentEl.createEl("h2", { text: "Bible Browser" });
		contentEl.createEl("p", {
			text: `Translation: ${this.plugin.settings.translation.toUpperCase()}`,
		});

		const columns = contentEl.createDiv();
		columns.style.display = "flex";
		columns.style.flexWrap = "wrap";
		columns.style.gap = "12px";
		columns.style.alignItems = "flex-start";

		const booksCol = columns.createDiv();
		booksCol.style.flex = "1 1 260px";
		booksCol.style.minWidth = "240px";

		const chaptersCol = columns.createDiv();
		chaptersCol.style.flex = "2 1 420px";
		chaptersCol.style.minWidth = "280px";

		booksCol.createEl("h3", { text: "Books" });
		const booksList = booksCol.createDiv();
		booksList.style.maxHeight = "70vh";
		booksList.style.overflowY = "auto";
		booksList.style.border = "1px solid var(--background-modifier-border)";
		booksList.style.borderRadius = "8px";
		booksList.style.padding = "6px";

		for (const book of books) {
			const label = book.commonName || book.name;
			const button = booksList.createEl("button", { text: label });
			button.style.display = "block";
			button.style.width = "100%";
			button.style.marginBottom = "4px";
			button.style.textAlign = "left";
			button.style.borderRadius = "6px";
			if (book.id.toUpperCase() === this.selectedBookId) {
				button.addClass("mod-cta");
			}
			button.addEventListener("click", () => {
				this.selectedBookId = book.id.toUpperCase();
				void this.refresh();
			});
		}

		const selectedLabel = selected.commonName || selected.name;
		chaptersCol.createEl("h3", { text: `${selectedLabel} Chapters` });
		const chaptersWrap = chaptersCol.createDiv();
		chaptersWrap.style.display = "grid";
		chaptersWrap.style.gridTemplateColumns = "repeat(auto-fill, minmax(64px, 1fr))";
		chaptersWrap.style.gap = "6px";
		chaptersWrap.style.maxHeight = "70vh";
		chaptersWrap.style.overflowY = "auto";

		const chapterCount = Math.max(1, selected.chapterCount ?? 1);
		for (let chapter = 1; chapter <= chapterCount; chapter += 1) {
			const chapterButton = chaptersWrap.createEl("button", { text: String(chapter) });
			chapterButton.style.minHeight = "34px";
			chapterButton.style.borderRadius = "6px";
			chapterButton.addEventListener("click", () => {
				void this.plugin.openChapterFromBrowser(selected, chapter);
			});
		}
	}
}

class BibleStrongsView extends ItemView {
	private code: string | null = null;

	constructor(leaf: WorkspaceLeaf, private readonly plugin: BereanStandardBibleBrowser) {
		super(leaf);
	}

	getViewType(): string {
		return BIBLE_STRONGS_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Strong's Concordance";
	}

	getIcon(): string {
		return "list-tree";
	}

	getState(): Record<string, unknown> {
		return this.code ? { code: this.code } : {};
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		await super.setState(state, result);
		const next = (state && typeof state === "object" ? state : {}) as BibleStrongsState;
		this.code = typeof next.code === "string" ? next.code : null;
		await this.refresh();
	}

	async onOpen(): Promise<void> {
		await this.refresh();
	}

	async setCode(code: string): Promise<void> {
		this.code = code;
		await this.refresh();
	}

	private async refresh(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: "Strong's Concordance" });

		if (!this.code) {
			contentEl.createEl("p", { text: "Use command: Lookup Strong's code." });
			return;
		}

		contentEl.createEl("p", { text: `Code: ${this.code}` });
		try {
			const entry = await this.plugin.lookupStrongsEntry(this.code);
			contentEl.createEl("h4", { text: entry.code });

			if (entry.lemma) {
				contentEl.createEl("p", { text: `Lemma: ${entry.lemma}` });
			}
			if (entry.transliteration) {
				contentEl.createEl("p", { text: `Transliteration: ${entry.transliteration}` });
			}
			if (entry.pronunciation) {
				contentEl.createEl("p", { text: `Pronunciation: ${entry.pronunciation}` });
			}
			if (entry.definition) {
				contentEl.createEl("p", { text: `Definition: ${entry.definition}` });
			}
			if (entry.kjvDefinition) {
				contentEl.createEl("p", { text: `KJV Definition: ${entry.kjvDefinition}` });
			}
			if (entry.derivation) {
				contentEl.createEl("p", { text: `Derivation: ${entry.derivation}` });
			}
			if (typeof entry.occurrences === "number") {
				contentEl.createEl("p", { text: `Occurrences: ${entry.occurrences}` });
			}

			if (entry.references && entry.references.length > 0) {
				contentEl.createEl("h5", { text: "References" });
				const list = contentEl.createEl("ul");
				for (const ref of entry.references.slice(0, 200)) {
					list.createEl("li", { text: ref });
				}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			contentEl.createEl("p", { text: message });
		}
	}
}

class BibleSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: BereanStandardBibleBrowser) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Berean Standard Bible Browser" });

		new Setting(containerEl)
			.setName("API base URL")
			.setDesc("Source API used to load book and chapter text.")
			.addText((text) =>
				text
					.setPlaceholder("https://bible.helloao.org/api")
					.setValue(this.plugin.settings.apiBaseUrl)
					.onChange(async (value) => {
						this.plugin.settings.apiBaseUrl = value.trim() || DEFAULT_SETTINGS.apiBaseUrl;
						await this.plugin.saveSettings();
						await this.plugin.resetProviderCaches();
					})
			);

			if (ENABLE_STRONGS_SIDEBAR) {
				new Setting(containerEl)
					.setName("Strongs API base URL")
					.setDesc("API base URL for Strong's concordance lookups.")
					.addText((text) =>
						text
							.setPlaceholder("https://bible.helloao.org/api")
							.setValue(this.plugin.settings.strongsApiBaseUrl)
							.onChange(async (value) => {
								this.plugin.settings.strongsApiBaseUrl = value.trim() || DEFAULT_SETTINGS.strongsApiBaseUrl;
								await this.plugin.saveSettings();
							})
					);
			}

		new Setting(containerEl)
			.setName("Translation code")
			.setDesc("Default is BSB for Berean Standard Bible.")
			.addText((text) =>
				text.setPlaceholder("BSB").setValue(this.plugin.settings.translation).onChange(async (value) => {
					this.plugin.settings.translation = (value.trim() || "BSB").toUpperCase();
					await this.plugin.saveSettings();
					await this.plugin.resetProviderCaches();
				})
			);

		new Setting(containerEl)
			.setName("Include footnotes")
			.setDesc("Show API footnote markers in rendered verses and inserted passages.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.includeFootnotes).onChange(async (value) => {
					this.plugin.settings.includeFootnotes = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Reset Bible caches")
			.setDesc("Clear in-memory API cache and reload book metadata.")
			.addButton((button) =>
				button.setButtonText("Reset").onClick(async () => {
					await this.plugin.resetProviderCaches();
					new Notice("Bible cache reset.");
				})
			);
	}
}
