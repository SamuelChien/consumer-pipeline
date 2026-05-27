import { readFileSync, writeFileSync, readdirSync, existsSync, createWriteStream } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';

const SKILLS_DIR = process.env.SKILLS_DIR || '/Users/samuelchien/dev/mega-skills-directory/mega-skills-union';
const SESSIONS_FILE = process.env.SESSIONS_FILE || '/Users/samuelchien/dev/claude-sessions-pipeline/output/deep-analysis.json';
const OUTPUT_DIR = process.env.OUTPUT_DIR || './data';

function parseSkill(filePath, dirName) {
  const content = readFileSync(filePath, 'utf-8');
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  let fm = {};
  let body = content;
  if (fmMatch) {
    try { fm = yaml.load(fmMatch[1]) || {}; } catch {}
    body = fmMatch[2];
  }

  const headings = [];
  const codeBlocks = [];
  for (const line of body.split('\n')) {
    const hm = line.match(/^(#{1,6})\s+(.+)/);
    if (hm) headings.push({ level: hm[1].length, text: hm[2] });
  }
  for (const m of body.matchAll(/```(\w*)\n([\s\S]*?)```/g)) {
    codeBlocks.push({ language: m[1] || 'text', length: m[2].length });
  }

  const stops = new Set(['the','a','an','is','are','was','were','be','been','have','has','had','do','does','did','will','would','could','should','to','of','in','for','on','with','at','by','from','as','and','but','or','not','this','that','it','its','they','them','their','what','which','who','when','where','why','how','all','any','some','no','other','such','only','own','same','than','too','very','just','also','use','using','file','set']);
  const words = (fm.name || dirName + ' ' + (fm.description || '') + ' ' + body.slice(0, 2000)).toLowerCase().replace(/[^a-z0-9\-]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !stops.has(w));
  const freq = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;
  const keywords = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([word, count]) => ({ word, count }));

  const categories = {
    security: ['security','vulnerability','exploit','penetration','firewall','encryption','auth','csrf','xss','injection'],
    testing: ['test','testing','jest','pytest','spec','assert','mock','coverage','e2e'],
    devops: ['deploy','docker','kubernetes','k8s','ci/cd','pipeline','terraform','ansible','helm'],
    frontend: ['react','vue','angular','css','html','dom','component','ui','ux','tailwind'],
    backend: ['api','server','database','rest','graphql','microservice','endpoint','middleware'],
    ai_ml: ['ai','machine-learning','model','llm','prompt','embedding','neural','training'],
    data: ['data','sql','etl','analytics','warehouse','spark','kafka'],
    cloud: ['aws','gcp','azure','cloud','lambda','serverless','s3','iam'],
    documentation: ['doc','readme','wiki','changelog','guide','tutorial'],
    productivity: ['workflow','automation','script','cli','tool','utility'],
    architecture: ['architecture','design-pattern','microservices','monolith','ddd','cqrs'],
    observability: ['monitoring','logging','tracing','metric','alert','dashboard','grafana'],
    mobile: ['ios','android','react-native','flutter','mobile','swift','kotlin'],
  };
  const lower = (fm.name || dirName + ' ' + body.slice(0, 1000)).toLowerCase();
  let bestCat = 'productivity', bestScore = 0;
  for (const [cat, kws] of Object.entries(categories)) {
    let s = 0;
    for (const kw of kws) if (lower.includes(kw)) s++;
    if (s > bestScore) { bestScore = s; bestCat = cat; }
  }

  return {
    id: dirName,
    name: fm.name || fm.title || dirName,
    description: (fm.description || body.split('\n').find(l => l.trim() && !l.startsWith('#')) || '').slice(0, 500),
    body: body.slice(0, 5000),
    bodyLength: body.length,
    tags: Array.isArray(fm.tags) ? fm.tags : (fm.tags ? [fm.tags] : []),
    category: fm.category || bestCat,
    tier: fm.tier || 'standard',
    author: fm.author || 'unknown',
    platforms: Array.isArray(fm.platforms) ? fm.platforms : ['universal'],
    allowedTools: fm['allowed-tools'] || fm.allowedTools || [],
    risk: fm.risk || 'safe',
    version: fm.version || '1.0.0',
    headings,
    codeBlocks,
    sourceCollection: 'mega-skills-union',
    analysis: {
      skillId: dirName,
      categories: { primary: bestCat, secondary: null, confidence: 0.7 },
      entities: [
        ...(Array.isArray(fm.tags) ? fm.tags : []).map(t => ({ name: t, type: 'tag', id: t })),
        ...(Array.isArray(fm['allowed-tools'] || fm.allowedTools || []) ? (fm['allowed-tools'] || fm.allowedTools || []) : []).map(t => ({ name: t, type: 'tool', id: t })),
      ],
      dependencies: [],
      qualityScore: {
        score: Math.min(100, (fm.description ? 10 : 0) + (headings.length >= 3 ? 10 : 0) + (body.length > 2000 ? 15 : body.length > 500 ? 8 : 0) + (codeBlocks.length > 0 ? 15 : 0) + ((fm.tags || []).length > 0 ? 5 : 0) + (Object.keys(fm).length > 3 ? 15 : 0) + 15),
      },
      complexity: { level: body.length > 5000 ? 'advanced' : body.length > 1500 ? 'intermediate' : 'basic', headingCount: headings.length, codeBlockCount: codeBlocks.length },
      keywords,
      analyzedAt: new Date().toISOString(),
    },
    processedAt: new Date().toISOString(),
  };
}

console.log('Exporting skills...');
const skillsOut = createWriteStream(join(OUTPUT_DIR, 'skills.jsonl'));
const dirs = readdirSync(SKILLS_DIR, { withFileTypes: true }).filter(d => d.isDirectory());
let skillCount = 0;
for (const dir of dirs) {
  const path = join(SKILLS_DIR, dir.name, 'SKILL.md');
  if (!existsSync(path)) continue;
  try {
    const skill = parseSkill(path, dir.name);
    skillsOut.write(JSON.stringify(skill) + '\n');
    skillCount++;
    if (skillCount % 500 === 0) console.log(`  ${skillCount} skills...`);
  } catch {}
}
skillsOut.end();
console.log(`Exported ${skillCount} skills to data/skills.jsonl`);

console.log('Exporting sessions...');
if (existsSync(SESSIONS_FILE)) {
  const sessions = JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8'));
  const sessionsOut = createWriteStream(join(OUTPUT_DIR, 'sessions.jsonl'));
  for (const s of sessions) {
    sessionsOut.write(JSON.stringify({
      sessionId: s.sessionId,
      project: s.project,
      messageCount: s.messageCount,
      analysis: s.shallow || s.analysis || {},
      deep: s.deep || null,
      processedAt: new Date().toISOString(),
    }) + '\n');
  }
  sessionsOut.end();
  console.log(`Exported ${sessions.length} sessions to data/sessions.jsonl`);
} else {
  console.log('No sessions file found');
}
