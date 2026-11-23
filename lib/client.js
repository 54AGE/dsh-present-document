window.__ModuleLoader__.load({
	id: "dsh-present-document",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");

		/** 与宿主侧约定的回环端口。 */
		const PORT = 17771;
		/** 轮询间隔（毫秒）；页面不可见时不轮询。 */
		const POLL_MS = 2500;
		/** 单次轮询的超时（毫秒）：宿主无应答就中断，别让挂起请求越堆越多。 */
		const POLL_TIMEOUT_MS = 8000;
		/** 浏览器侧按会话缓存的上限，与宿主侧同口径，防止长期运行无限增长。 */
		const MAX_SESSIONS = 24;
		/** 列表项标记（-、*、+、1.、1)）；是否有序列表由 `listItemOf` 解析出的序号决定。 */
		const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
		/** 本插件在标签页系统里的身份，也是槽位分发 key。 */
		const TAB_ID = "dsh-present-document";
		/** 标签页 kind；按命名口径与 TAB_ID 同名，openTab 用它。 */
		const TAB_KIND = "dsh-present-document";

		/** 还没有文档时的占位内容。 */
		const EMPTY_DOC = { title: "", markdown: "" };
		/** 会话 id → 该会话的文档；每个会话的面板只读自己那份，别的会话推来的文档不会串进来。 */
		const docs = new Map();
		/** 当前正在查看的会话 id；面板拿不到自身 sessionId 时的兜底。 */
		let activeSession = "";
		/** 极简订阅（面板组件从这里渲染）。 */
		const listeners = new Set();
		/** 写入并按上限淘汰最久未更新的一项。 */
		function remember(map, key, value) {
			map.delete(key);
			map.set(key, value);
			while (map.size > MAX_SESSIONS) {
				const oldest = map.keys().next();
				if (oldest.done) break;
				map.delete(oldest.value);
			}
		}
		function docOf(session) {
			return docs.get(session) ?? EMPTY_DOC;
		}
		function publish(session, next) {
			const previous = docs.get(session);
			if (previous !== undefined && previous.title === next.title && previous.markdown === next.markdown) {
				// 内容没变也算一次访问，别让正在查看的会话被淘汰掉。
				remember(docs, session, previous);
				return;
			}
			remember(docs, session, next);
			for (const listener of [...listeners]) {
				try {
					listener();
				} catch (error) {
					console.error("[dsh-present-document] 文档订阅者异常：" + String(error && error.message));
				}
			}
		}
		function useDocument(session) {
			const [state, setState] = react.useState(() => ({ session, doc: docOf(session) }));
			react.useEffect(() => {
				const sync = () => setState({ session, doc: docOf(session) });
				listeners.add(sync);
				sync();
				return () => listeners.delete(sync);
			}, [session]);
			// 渲染期就按当前会话取值：切会话的首帧不得沿用上一会话的文档。
			return state.session === session ? state.doc : docOf(session);
		}

		/** 行内标记：**粗体**、`代码`；粗体内部再解析一次代码，免得侧栏里露出裸反引号。 */
		function inline(text, depth = 0) {
			const out = [];
			const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
			let last = 0;
			let match;
			let index = 0;
			while ((match = pattern.exec(text)) !== null) {
				if (match.index > last) out.push(text.slice(last, match.index));
				const token = match[0];
				if (token.startsWith("**")) {
					const body = token.slice(2, -2);
					out.push(react.createElement("strong", { key: "b" + index++ }, depth < 2 ? inline(body, depth + 1) : body));
				} else {
					out.push(react.createElement("code", { key: "c" + index++, style: CODE_INLINE }, token.slice(1, -1)));
				}
				last = match.index + token.length;
			}
			if (last < text.length) out.push(text.slice(last));
			return out;
		}

		const CODE_INLINE = {
			fontFamily: "var(--dsh-font-mono, ui-monospace, monospace)",
			fontSize: "0.92em",
			padding: "0 4px",
			borderRadius: "4px",
			background: "rgba(127,127,127,0.16)",
		};
		const PRE = {
			fontFamily: "var(--dsh-font-mono, ui-monospace, monospace)",
			fontSize: "12.5px",
			lineHeight: 1.55,
			padding: "10px 12px",
			borderRadius: "8px",
			background: "rgba(127,127,127,0.12)",
			overflowX: "auto",
			margin: "8px 0",
		};

		const TABLE = {
			borderCollapse: "collapse",
			display: "block",
			overflowX: "auto",
			margin: "8px 0",
			fontSize: "12.5px",
		};
		const TH = {
			border: "1px solid rgba(127,127,127,0.3)",
			padding: "4px 8px",
			textAlign: "left",
			fontWeight: 600,
			whiteSpace: "nowrap",
		};
		const TD = {
			border: "1px solid rgba(127,127,127,0.3)",
			padding: "4px 8px",
			textAlign: "left",
			verticalAlign: "top",
		};

		/** 表格行：| a | b | → ["a", "b"]。 */
		function splitRow(line) {
			return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
		}

		/** 分隔行（|---|---| 或 |:--:|）：用它判断首行是不是表头。 */
		function isSeparatorRow(cells) {
			return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
		}

		/** 表格一行；cellTag 是单元格标签（th / td）。 */
		function tableRow(cellTag, cells, rowKey) {
			return react.createElement(
				"tr",
				{ key: rowKey },
				cells.map((cell, cellIndex) => react.createElement(cellTag, { key: "c" + cellIndex, style: cellTag === "th" ? TH : TD }, inline(cell))),
			);
		}

		/** 行首缩进宽度：判断「项内续行」与「更深一层列表」都靠它。 */
		function indentOf(line) {
			return line.length - line.replace(/^\s+/, "").length;
		}

		/** 拆一个列表项：缩进、序号（无序列表为 null）、去掉标记后的正文。 */
		function listItemOf(line) {
			const match = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
			if (match === null) return { indent: indentOf(line), number: null, text: line.trim() };
			return {
				indent: match[1].length,
				number: match[3] === undefined ? null : Number(match[3]),
				text: match[4],
			};
		}

		/** 极简 Markdown → React：标题、列表、表格、围栏代码、段落。 */
		function renderMarkdown(text) {
			const lines = String(text ?? "").split(/\r?\n/);
			const blocks = [];
			let index = 0;
			let key = 0;
			while (index < lines.length) {
				const line = lines[index];
				if (line.trim() === "") {
					index += 1;
					continue;
				}
				if (/^```/.test(line)) {
					const body = [];
					index += 1;
					while (index < lines.length && !/^```/.test(lines[index])) {
						body.push(lines[index]);
						index += 1;
					}
					index += 1;
					blocks.push(react.createElement("pre", { key: "p" + key++, style: PRE }, body.join("\n")));
					continue;
				}
				const heading = line.match(/^(#{1,6})\s+(.*)$/);
				if (heading !== null) {
					const level = heading[1].length;
					blocks.push(
						react.createElement(
							"h" + Math.min(level + 1, 6),
							{ key: "h" + key++, style: { fontSize: level <= 2 ? "15px" : "13.5px", margin: "14px 0 6px", fontWeight: 600 } },
							inline(heading[2]),
						),
					);
					index += 1;
					continue;
				}
				if (/^\s*\|/.test(line)) {
					const rows = [];
					while (index < lines.length && /^\s*\|/.test(lines[index])) {
						rows.push(splitRow(lines[index]));
						index += 1;
					}
					const hasHeader = rows.length > 1 && isSeparatorRow(rows[1]);
					const bodyRows = hasHeader ? rows.slice(2) : rows;
					blocks.push(
						react.createElement(
							"table",
							{ key: "tb" + key++, style: TABLE },
							hasHeader ? react.createElement("thead", null, tableRow("th", rows[0], "th")) : null,
							react.createElement("tbody", null, bodyRows.map((cells, rowIndex) => tableRow("td", cells, "r" + rowIndex))),
						),
					);
					continue;
				}
				if (LIST_ITEM.test(line)) {
					const opened = listItemOf(line);
					const ordered = opened.number !== null;
					const baseIndent = opened.indent;
					const items = [];
					let current = null;
					/** 收口当前项：首行是项标题，续行各占一行，同一个序号下不再分点。 */
					const flush = () => {
						if (current === null) return;
						const body = current.text.map((row, rowIndex) => (rowIndex === 0
							? inline(row)
							: react.createElement("div", { key: "d" + rowIndex, style: { margin: "2px 0" } }, inline(row))));
						items.push(
							react.createElement(
								"li",
								{
									key: "li" + key++,
									// 按作者写的序号渲染：严重 → 待定 连续编号（4、5、6）时不会被重排成 1、2、3。
									value: current.number === null ? undefined : current.number,
									style: { margin: "3px 0" },
								},
								body,
							),
						);
						current = null;
					};
					while (index < lines.length) {
						const row = lines[index];
						if (row.trim() === "") {
							// 空行不结束列表：后面还是列表项或更深缩进，就接着同一个列表。
							let look = index + 1;
							while (look < lines.length && lines[look].trim() === "") look += 1;
							const next = look < lines.length ? lines[look] : null;
							if (next === null || (!LIST_ITEM.test(next) && indentOf(next) <= baseIndent)) break;
							index = look;
							continue;
						}
						if (LIST_ITEM.test(row)) {
							const parsed = listItemOf(row);
							// 比首项更深：属于当前项的子清单，按续行处理，不占新序号。
							if (current !== null && parsed.indent > baseIndent) {
								current.text.push(parsed.number === null ? "· " + parsed.text : parsed.number + ". " + parsed.text);
								index += 1;
								continue;
							}
							if (parsed.indent < baseIndent) break;
							flush();
							current = { number: parsed.number, text: [parsed.text] };
							index += 1;
							continue;
						}
						// 非列表行：缩进比首项深才算项内续行（问题 / 拟改动 / 判定依据…）；表格与围栏代码不并进项内。
						if (current !== null && indentOf(row) > baseIndent && !/^\s*(\||```)/.test(row)) {
							current.text.push(row.trim());
							index += 1;
							continue;
						}
						break;
					}
					flush();
					blocks.push(
						react.createElement(
							ordered ? "ol" : "ul",
							{
								key: "l" + key++,
								start: ordered && opened.number !== 1 ? opened.number : undefined,
								style: { margin: "6px 0", paddingLeft: "20px" },
							},
							items,
						),
					);
					continue;
				}
				const paragraph = [];
				while (
					index < lines.length
					&& lines[index].trim() !== ""
					&& !/^(#{1,6}\s|```)/.test(lines[index])
					&& !/^\s*\|/.test(lines[index])
					&& !LIST_ITEM.test(lines[index])
				) {
					paragraph.push(lines[index]);
					index += 1;
				}
				blocks.push(
					react.createElement("p", { key: "t" + key++, style: { margin: "6px 0", lineHeight: 1.65 } }, inline(paragraph.join(" "))),
				);
			}
			return blocks;
		}

		/** 面板所属的会话 id：槽位按会话分发，props.sessionId 就是它；缺省时退回当前查看的会话。 */
		function sessionOf(props) {
			if (props !== null && typeof props === "object" && typeof props.sessionId === "string" && props.sessionId !== "") return props.sessionId;
			return activeSession;
		}

		/** 标签页内容：只读文档。 */
		function DocumentPanel(props) {
			const current = useDocument(sessionOf(props));
			return react.createElement(
				"div",
				{
					style: {
						height: "100%",
						overflowY: "auto",
						padding: "16px 18px 32px",
						fontSize: "13px",
						lineHeight: 1.65,
					},
				},
				current.markdown === ""
					? react.createElement("div", { style: { opacity: 0.6 } }, "还没有文档。")
					: renderMarkdown(current.markdown),
			);
		}

		/** 标签页 chip 文案。 */
		function DocumentTitle(props) {
			const current = useDocument(sessionOf(props));
			return react.createElement("span", null, current.title === "" ? "文档" : current.title);
		}

		/** 本插件需要的客户端服务；uiSession 用来取当前查看的会话 id，轮询只问这个会话的文档。 */
		const inject = ["slots", "sidebarRightTabs", "sidebarRight", "uiSession"];

		/**
		 * 注册标签页类型并开始轮询宿主推送。
		 * @param ctx - 客户端根上下文。
		 */
		function apply(ctx) {
			ctx.effect(() => {
				try {
					return ctx.sidebarRightTabs.register({
						id: TAB_ID,
						kind: TAB_KIND,
						keepMounted: true,
						priority: "extension",
						title: () => "文档",
					});
				} catch (error) {
					console.error("[dsh-present-document] 标签页类型注册失败：" + String(error && error.message));
					return () => {};
				}
			}, "dsh-present-document: tab type");

			ctx.slots.inject("sidebar.right.pane.tab", () => {
				try {
					return ctx.slots.register({ name: "sidebar.right.pane.tab", key: TAB_ID }, DocumentPanel);
				} catch (error) {
					console.error("[dsh-present-document] 文档面板槽位注册失败：" + String(error && error.message));
					return () => {};
				}
			});
			ctx.slots.inject("sidebar.right.pane.tab.title", () => {
				try {
					return ctx.slots.register({ name: "sidebar.right.pane.tab.title", key: TAB_ID }, DocumentTitle);
				} catch (error) {
					console.error("[dsh-present-document] 标题槽位注册失败：" + String(error && error.message));
					return () => {};
				}
			});

			/** 会话 id → 已推送过的文档版本 at；按会话分开记，宿主实例重建后浏览器也不会错判新旧。 */
			const seenAt = new Map();
			/** 轮询失败只在「正常→失败」边沿记一次日志，避免每轮刷屏。 */
			let pollFailed = false;

			/** 当前正在查看的会话 id；取不到就返回空串——宁可不推，也不把文档串到别的会话。 */
			function currentSession() {
				try {
					const key = ctx.uiSession.adapter.current.getSnapshot().key;
					return typeof key === "string" ? key : "";
				} catch (error) {
					return "";
				}
			}

			/** 本轮是否还没结束；宿主无应答时不叠加请求。 */
			let inFlight = false;

			const poll = () => {
				if (inFlight || document.visibilityState !== "visible") return;
				const session = currentSession();
				if (session === "") return;
				activeSession = session;
				inFlight = true;
				const controller = new AbortController();
				const timer = window.setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
				fetch("http://127.0.0.1:" + PORT + "/latest?session=" + encodeURIComponent(session), { cache: "no-store", signal: controller.signal })
					.then((response) => {
						pollFailed = false;
						return response.ok ? response.json() : undefined;
					})
					.then((next) => {
						if (next === undefined || typeof next.at !== "number") return;
						// 请求途中已经切走，这次结果就不算到新会话头上。
						if (currentSession() !== session) return;
						publish(session, {
							title: typeof next.title === "string" ? next.title : "",
							markdown: typeof next.markdown === "string" ? next.markdown : "",
						});
						if (next.at <= 0 || next.at <= (seenAt.get(session) ?? 0)) return;
						remember(seenAt, session, next.at);
						try {
							ctx.sidebarRight.openTab(TAB_KIND, { params: { at: next.at } });
						} catch (error) {
							console.error("[dsh-present-document] 打开侧边栏失败：" + String(error && error.message));
						}
					})
					.catch((error) => {
						if (pollFailed) return;
						pollFailed = true;
						console.error("[dsh-present-document] 轮询宿主失败：" + String(error && error.message));
					})
					.finally(() => {
						inFlight = false;
						window.clearTimeout(timer);
					});
			};

			ctx.effect(() => {
				const current = ctx.uiSession.adapter.current;
				// 切会话立刻补一次轮询，不必等下一个 2500ms 才看到那个会话的文档。
				const unsubscribe = current.subscribe(() => poll());
				return () => unsubscribe();
			}, "dsh-present-document: session switch");

			ctx.effect(() => {
				const timer = window.setInterval(poll, POLL_MS);
				const onVisibility = () => poll();
				document.addEventListener("visibilitychange", onVisibility);
				poll();
				return () => {
					window.clearInterval(timer);
					document.removeEventListener("visibilitychange", onVisibility);
				};
			}, "dsh-present-document: poller");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
