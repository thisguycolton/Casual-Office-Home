import { Plugin } from '@univerjs/core';

/**
 * `@casualoffice/sheets` lazily imports `@univerjs/docs-mention-ui` (the @-mention picker for cell comments), but that
 * package is not published to npm, so the bundler cannot resolve it. The comment group is not enabled in our build
 * (`lazyPlugins={false}`), so this inert stand-in is never registered; it only keeps the module graph resolvable.
 * Consequence: no @-mentions in cell comments. Remove this alias when upstream publishes the package.
 */
export class UniverDocsMentionUIPlugin extends Plugin {
  static override pluginName = 'CASUAL_STUB_DOCS_MENTION_UI';
  // Satisfies the base class's abstract member; the stub is never given a dependency injector it would use.
  declare protected readonly _injector: never;
}
