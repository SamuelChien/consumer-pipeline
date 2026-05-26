const CHUNK_SIZE = 1500;
const CHUNK_OVERLAP = 200;

export function chunkText(text, metadata = {}) {
  if (!text || text.length < CHUNK_SIZE) {
    return [{ text, metadata, index: 0 }];
  }

  const chunks = [];
  let start = 0;
  let index = 0;

  while (start < text.length) {
    let end = start + CHUNK_SIZE;

    if (end < text.length) {
      const lastNewline = text.lastIndexOf('\n', end);
      const lastPeriod = text.lastIndexOf('. ', end);
      if (lastNewline > start + CHUNK_SIZE / 2) end = lastNewline + 1;
      else if (lastPeriod > start + CHUNK_SIZE / 2) end = lastPeriod + 2;
    }

    end = Math.min(end, text.length);
    chunks.push({
      text: text.slice(start, end).trim(),
      metadata: { ...metadata, chunkIndex: index },
      index,
    });

    start = end - CHUNK_OVERLAP;
    if (start >= text.length) break;
    index++;
  }

  return chunks;
}

export function chunkByHeadings(markdown, metadata = {}) {
  const sections = [];
  const lines = markdown.split('\n');
  let currentHeading = 'introduction';
  let currentContent = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch && currentContent.length > 0) {
      sections.push({
        heading: currentHeading,
        text: currentContent.join('\n').trim(),
        metadata: { ...metadata, heading: currentHeading },
      });
      currentHeading = headingMatch[2].trim();
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }

  if (currentContent.length > 0) {
    sections.push({
      heading: currentHeading,
      text: currentContent.join('\n').trim(),
      metadata: { ...metadata, heading: currentHeading },
    });
  }

  const chunks = [];
  for (const section of sections) {
    if (section.text.length > CHUNK_SIZE) {
      chunks.push(...chunkText(section.text, section.metadata));
    } else if (section.text.length > 0) {
      chunks.push({ text: section.text, metadata: section.metadata, index: chunks.length });
    }
  }

  return chunks;
}
