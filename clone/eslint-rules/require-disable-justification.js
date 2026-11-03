'use strict';
// parlance/require-disable-justification: an eslint-disable comment for a security rule must say why
// (`// eslint-disable-next-line parlance/no-unescaped-html -- value is a server-generated id`).
const SECURITY_RULES = /\b(parlance\/no-unescaped-html|no-unsanitized\/(?:method|property)|no-eval|no-implied-eval|no-new-func|no-script-url)\b/;

module.exports = {
  meta: {
    type: 'problem',
    docs: { description: 'require a written justification on eslint-disable comments for security rules' },
    schema: [],
    messages: { missing: 'Disabling {{rule}} needs a justification: add `-- <why this is safe>` (at least 12 characters).' },
  },
  create(context) {
    return {
      Program() {
        for (const c of context.sourceCode.getAllComments()) {
          const text = c.value.trim();
          if (!/^eslint-disable/.test(text)) continue;
          const m = SECURITY_RULES.exec(text);
          if (!m) continue;
          const why = text.split(/\s--\s/)[1];
          if (!why || why.trim().length < 12) context.report({ loc: c.loc, messageId: 'missing', data: { rule: m[1] } });
        }
      },
    };
  },
};
