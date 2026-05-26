const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'each',
  'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them', 'their',
  'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how', 'all',
  'any', 'some', 'no', 'every', 'other', 'such', 'only', 'own', 'same',
  'than', 'too', 'very', 'just', 'also', 'use', 'using', 'file', 'set',
]);

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\-_]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOPWORDS.has(t));
}

export class BM25 {
  constructor(k1 = 1.5, b = 0.75) {
    this.k1 = k1;
    this.b = b;
    this.documents = new Map();
    this.df = new Map();
    this.avgDl = 0;
  }

  addDocument(id, text) {
    const terms = tokenize(text);
    const tf = new Map();
    for (const term of terms) {
      tf.set(term, (tf.get(term) || 0) + 1);
    }

    this.documents.set(id, { terms, tf, length: terms.length });

    for (const term of new Set(terms)) {
      this.df.set(term, (this.df.get(term) || 0) + 1);
    }

    let totalLength = 0;
    for (const doc of this.documents.values()) totalLength += doc.length;
    this.avgDl = totalLength / this.documents.size;
  }

  search(query, limit = 20) {
    const queryTerms = tokenize(query);
    const n = this.documents.size;
    const scores = [];

    for (const [id, doc] of this.documents) {
      let score = 0;
      for (const term of queryTerms) {
        const tf = doc.tf.get(term) || 0;
        if (tf === 0) continue;

        const docFreq = this.df.get(term) || 0;
        const idf = Math.log((n - docFreq + 0.5) / (docFreq + 0.5) + 1);
        const tfNorm = (tf * (this.k1 + 1)) /
          (tf + this.k1 * (1 - this.b + this.b * (doc.length / this.avgDl)));
        score += idf * tfNorm;
      }
      if (score > 0) scores.push({ id, score });
    }

    return scores.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  getIDF(term) {
    const n = this.documents.size;
    const df = this.df.get(term) || 0;
    return Math.log((n - df + 0.5) / (df + 0.5) + 1);
  }
}
