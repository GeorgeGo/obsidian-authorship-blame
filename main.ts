import {
  EditorView,
  Decoration,
  DecorationSet,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";
import { Plugin, Editor, MarkdownView, WorkspaceLeaf } from "obsidian";
import { EditorState, RangeSetBuilder } from "@codemirror/state";
import * as Diff from "diff";

interface HistoryItem {
  mtime: number;
  user: string;
  size: number;
  content?: string; // Content is optional, as it might not be immediately available
}

interface UserHighlight {
  user: string;
  color: string;
}

export default class CollabSyncHighlightPlugin extends Plugin {
  userColors: Record<string, string> = {};
  decorations: DecorationSet = Decoration.none;

  async onload() {
    const plugin = this;
    this.registerEditorExtension(
      ViewPlugin.fromClass(
        class {
          decorations: DecorationSet = Decoration.none;

          constructor(view: EditorView) {
            this.decorations = Decoration.none;
            this.updateDecorations(view);
          }

          update(update: ViewUpdate) {
            if (update.docChanged || update.viewportChanged) {
              this.updateDecorations(update.view);
            }
          }

          async updateDecorations(view: EditorView) {
            this.decorations = await plugin.buildDecorations(view);
          }
        },
        {
          decorations: (v) => v.decorations,
        },
      ),
    );
  }

  async getFileVersions(leaf: WorkspaceLeaf): Promise<HistoryItem[]> {
    const sync = app.internalPlugins.plugins.sync;
    if (!sync) {
      return [];
    }

    const file = (leaf.view as MarkdownView).file;
    if (!file) {
      return [];
    }

    const history = await sync.instance.getHistory(file.path);
    if (!history) {
      return [];
    }

    const decoder = new TextDecoder("utf-8");
    //Fetch content for each history item.
    const historyWithContent = await Promise.all(
      history.items.map(async (item) => {
        let buffer = await sync.instance.getContentForVersion(item.uid);
        return { user: item.device, content: decoder.decode(buffer) };
      }),
    );

    return historyWithContent;
  }

  getUserColor(user: string): string {
    if (!this.userColors[user]) {
      // Generate a simple hash-based color
      let hash = 0;
      for (let i = 0; i < user.length; i++) {
        hash = user.charCodeAt(i) + ((hash << 5) - hash);
      }
      const color = `#${((hash & 0x00ffffff) << 0).toString(16).padStart(6, "0")}`;
      this.userColors[user] = color;
    }
    return this.userColors[user];
  }

  findNextChangeIndex(history, startingIndex: number): number {
    let users = history.map((h) => h.user);
    let starting_user = users[startingIndex];

    for (let i = startingIndex + 1; i < users.length; i++) {
      if (users[i] != starting_user) {
        return i;
      }
    }
    return history.length;
  }

  getCharFromUser(user) {
    let char = "_";
    if (user === "bean_machine") {
      char = "b";
    } else if (user === "Bident-of-Thassa.local") {
      char = "T";
    }
    return char;
  }

  replace_chars(s, char, start_index, length) {
    if (start_index + length > s.length) {
      s += "_".repeat(start_index + length - s.length);
    }
    let s_mod =
      s.slice(0, start_index) +
      char.repeat(length) +
      s.slice(start_index + length, s.length);
    return s_mod;
  }

  getSegmentFromHistory(history): string {
    let change_indices = [];
    let current_index = 0;
    while (current_index != history.length) {
      let next_index = this.findNextChangeIndex(history, current_index);
      change_indices.push(next_index);
      current_index = next_index;
    }
    change_indices.push(history.length);

    // testing

    // sssssBBBBssssBBBssss
    // 5 9 13 17 22 (append last + 1)
    // 0 1  2  3  4
    //
    // 0 1 2 3
    // 4,8 current-1 next-1
    // 8, 12
    // 12, 16
    // 16, 21

    let segments = "";
    for (let i = 0; i < change_indices.length - 1; i++) {
      let prev_hist = history[change_indices[i] - 1];
      let next_hist = history[change_indices[i + 1] - 1];

      if (prev_hist.user !== next_hist.user) {
        let diff = Diff.diffChars(prev_hist.content, next_hist.content);
        let offset = 0;
        diff.forEach((change) => {
          if (change.added) {
            let char = this.getCharFromUser(next_hist.user);
            segments = this.replace_chars(segments, char, offset, change.count);
            offset += change.count;
          } else if (change.removed) {
            segments = this.replace_chars(segments, "", offset, change.count);
            offset -= change.count;
          } else {
            let char = this.getCharFromUser(prev_hist.user);
            segments = this.replace_chars(segments, char, offset, change.count);
            offset += change.count;
          }
        });
      }
    }
    return segments;
  }

  convert_segment_to_groups(segments: string) {
    let color_dict = {
      b: this.getUserColor("bean"),
      T: this.getUserColor("Bident"),
      _: this.getUserColor("underscore"),
    };

    color_dict.b = "red";
    color_dict.T = "blue";

    let groups = [
      { start: 0, end: 1, color: color_dict[segments[0]], char: segments[0] },
    ];
    for (let i = 1; i < segments.length; i++) {
      if (groups[groups.length - 1].char === segments[i]) {
        groups[groups.length - 1].end += 1;
      } else {
        groups.push({
          start: i,
          end: i + 1,
          color: color_dict[segments[i]],
          char: segments[i],
        });
      }
    }
    return groups;
  }

  async buildDecorations(view: EditorView): Promise<DecorationSet> {
    const leaf = app.workspace.getActiveViewOfType(MarkdownView)?.leaf;
    if (!leaf) {
      return Decoration.none;
    }

    const history = await this.getFileVersions(leaf);
    if (!history || history.length === 0) {
      return Decoration.none;
    }

    const builder = new RangeSetBuilder<Decoration>();
    const editor = view.state.doc.toString();

    if (history.length > 1) {
      history.reverse();
      let segment = this.getSegmentFromHistory(history);
      let groups = this.convert_segment_to_groups(segment);
      groups.forEach((g) => {
        builder.add(
          g.start,
          g.end,
          Decoration.mark({
            attributes: {
              style: `background-color: ${g.color}; opacity: 0.5;`,
            },
          }),
        );
      });
    }
    return builder.finish();

    // TODO: go through history and assign different changes to different users
    // apply those changes to the current doc version
    // const latestVersion = history[1];
    // const previousVersion = history[0];

    //   if (latestVersion.content && previousVersion.content) {
    //     const diff = Diff.diffChars(
    //       previousVersion.content,
    //       latestVersion.content,
    //     );
    //
    //     if (diff) {
    //       let offset = 0;
    //       diff.forEach((change) => {
    //         if (change.added) {
    //           const start = offset;
    //           const end = offset + change.value.length;
    //           const color = this.getUserColor(latestVersion.user);
    //           console.log(start, end, color);
    //           builder.add(
    //             start,
    //             end,
    //             Decoration.mark({
    //               attributes: {
    //                 style: `background-color: ${color}; opacity: 0.5;`,
    //               },
    //             }),
    //           );
    //         }
    //         offset += change.value.length;
    //       });
    //     }
    //   }
    // }
    //
  }
}
