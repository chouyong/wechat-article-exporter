import TurndownService from 'turndown';

function normalizeTableCellText(text: string) {
  return (text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/\n+/g, '<br>')
    .replace(/\|/g, '\\|')
    .trim();
}

function extractNodeTextWithBreaks(node: Node) {
  if (node.nodeType === node.TEXT_NODE) {
    return (node.textContent || '').replace(/\u00a0/g, ' ');
  }

  if (node.nodeType !== node.ELEMENT_NODE) {
    return '';
  }

  const element = node as HTMLElement;
  const tagName = element.tagName.toLowerCase();

  if (tagName === 'br') {
    return '\n';
  }

  const childText = Array.from(element.childNodes).map(extractNodeTextWithBreaks).join('');
  if (['div', 'p', 'section', 'article', 'li'].includes(tagName)) {
    return `${childText}\n`;
  }
  return childText;
}

function normalizeListItemText(text: string) {
  return (text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/^\s*[•·▪◦●]\s*/u, '')
    .replace(/^\s*[*-]\s*[•·▪◦●]\s*/u, '')
    .replace(/^\s*\d+\.\s+\d+\.\s+/u, (_match) => {
      const normalized = _match.replace(/^\s*(\d+\.)\s+\d+\.\s+/u, '$1 ');
      return normalized;
    })
    .replace(/^\s*\d+\)\s+\d+\)\s+/u, (_match) => {
      const normalized = _match.replace(/^\s*(\d+\))\s+\d+\)\s+/u, '$1 ');
      return normalized;
    })
    .trim();
}

function detectCodeFenceLanguage(code: string) {
  const text = (code || '').trim();
  if (!text) {
    return '';
  }

  const shellHints = [
    /^#!/m,
    /^\s*(cd|pwd|ls|cat|echo|mkdir|rm|cp|mv|git|cargo|npm|yarn|pnpm|node|python|pip|curl|wget|export)\b/m,
    /^\s*#\s/m,
    /^\s*\.\//m,
    /^\s*\$\s/m,
  ];
  if (shellHints.some(pattern => pattern.test(text))) {
    return 'bash';
  }

  const rustHints = [
    /\blet\s+[a-zA-Z_][\w]*\s*[:=]/,
    /\bfn\s+[a-zA-Z_][\w]*\s*\(/,
    /\bimpl\b/,
    /\bpub\s+(fn|struct|enum|trait)\b/,
    /\buse\s+[a-zA-Z_][\w:]*;/,
    /::/,
  ];
  if (rustHints.some(pattern => pattern.test(text))) {
    return 'rust';
  }

  const tsHints = [
    /\b(const|let|var)\s+[a-zA-Z_$][\w$]*\s*[:=]/,
    /\b(interface|type|enum|async function|function)\b/,
    /=>/,
  ];
  if (tsHints.some(pattern => pattern.test(text))) {
    return 'ts';
  }

  return '';
}

function normalizeCodeFenceBody(code: string) {
  return (code || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '');
}

function buildMarkdownTable(tableNode: HTMLElement) {
  const rows = Array.from(tableNode.querySelectorAll('tr'))
    .map(row =>
      Array.from(row.querySelectorAll('th, td')).map(cell =>
        normalizeTableCellText(cell.textContent || ''),
      ),
    )
    .filter(row => row.some(cell => cell));

  if (rows.length === 0) {
    return '';
  }

  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const normalizedRows = rows.map(row => {
    const next = row.slice(0, columnCount);
    while (next.length < columnCount) {
      next.push('');
    }
    return next;
  });

  const header = normalizedRows[0];
  const bodyRows = normalizedRows.slice(1);
  const separator = new Array(columnCount).fill('---');
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...bodyRows.map(row => `| ${row.join(' | ')} |`),
  ];

  return `\n\n${lines.join('\n')}\n\n`;
}

function extractPreformattedCode(node: HTMLElement) {
  const codeNode = node.querySelector('code');
  const rawCode =
    codeNode?.getAttribute('data-raw-code')
    || extractNodeTextWithBreaks(codeNode || node)
    || codeNode?.textContent
    || node.textContent
    || '';
  return rawCode
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/\n+$/g, '')
    .replace(/^\n+/g, '');
}

export function createMarkdownTurndownService() {
  const service = new TurndownService({ headingStyle: 'atx' });

  service.addRule('table', {
    filter(node) {
      return node.nodeName === 'TABLE';
    },
    replacement(_content, node) {
      return buildMarkdownTable(node as HTMLElement);
    },
  });

  service.addRule('pre', {
    filter(node) {
      return node.nodeName === 'PRE';
    },
    replacement(_content, node) {
      const code = normalizeCodeFenceBody(extractPreformattedCode(node as HTMLElement));
      if (!code) {
        return '';
      }
      const language = detectCodeFenceLanguage(code);
      return `\n\n\`\`\`${language}\n${code}\n\`\`\`\n\n`;
    },
  });

  service.addRule('listItem', {
    filter(node) {
      return node.nodeName === 'LI';
    },
    replacement(content, node, options) {
      const parent = node.parentNode as HTMLOListElement | HTMLUListElement | null;
      const cleaned = normalizeListItemText(content);
      if (!cleaned) {
        return '\n';
      }

      const isOrdered = parent?.nodeName === 'OL';
      const bullet = isOrdered ? `${(options as any).bulletListMarker || '-'} ` : `${options.bulletListMarker} `;

      if (isOrdered && parent) {
        const start = Number(parent.getAttribute('start') || '1');
        const siblings = Array.from(parent.children).filter(child => child.nodeName === 'LI');
        const index = Math.max(siblings.indexOf(node as HTMLLIElement), 0);
        return `\n${start + index}. ${cleaned}`;
      }

      return `\n${bullet}${cleaned}`;
    },
  });

  return service;
}

function normalizeLooseMarkdownLines(markdown: string) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const normalized: string[] = [];
  let inFence = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/g, '');
    const trimmed = line.trim();

    if (/^```/.test(trimmed)) {
      inFence = !inFence;
      normalized.push(line);
      continue;
    }

    if (inFence) {
      normalized.push(line);
      continue;
    }

    if (!trimmed) {
      if (normalized[normalized.length - 1] !== '') {
        normalized.push('');
      }
      continue;
    }

    normalized.push(
      line
        .replace(/^\s*[*-]\s*[•·▪◦●]\s+/u, '* ')
        .replace(/^\d+\.\s+\d+\.\s+/u, match => match.replace(/^\s*(\d+\.)\s+\d+\.\s+/u, '$1 '))
        .replace(/^\d+\)\s+\d+\)\s+/u, match => match.replace(/^\s*(\d+\))\s+\d+\)\s+/u, '$1 '))
        .replace(/(\d+)\s*~\s*(\d+)/g, '$1~$2')
        .replace(/(?<![\w-])(\d+(?:\.\d+)?[KMGTP]?)\s*-\s*(\d+(?:\.\d+)?[KMGTP]?)(?![\w-])/g, '$1~$2')
        .replace(/(\d+[A-Za-z]+)\s+(\d+[A-Za-z]+)/g, '$1 $2'),
    );
  }

  return normalized.join('\n').replace(/^\n+|\n+$/g, '');
}

export function postProcessMarkdown(markdown: string) {
  return normalizeLooseMarkdownLines(markdown)
    .replace(/\b(\d{1,3})~0([KMGTP]?)(\s+tokens\b)/g, '$10$2$3')
    .replace(/~(\d{1,3})~0([KMGTP]?)(\s+tokens\b)/g, '~$10$2$3')
    .replace(/(\d+)\s*~\s*(\d+)\s+tokens\b/g, '$1~$2 tokens')
    .replace(/(?<![\w-])(\d+(?:\.\d+)?[KMGTP]?)\s*-\s*(\d+(?:\.\d+)?[KMGTP]?)(?![\w-])/g, '$1~$2')
    .replace(/([<>=~]?\s*\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?\s*(?:秒|ms|MB|GB|tokens))/g, '$1-$2');
}
