import neo4j from 'neo4j-driver';
import { config } from './config.js';

export class StoreClients {
  constructor() {
    this.neo4jDriver = neo4j.driver(
      config.neo4j.uri,
      neo4j.auth.basic(config.neo4j.user, config.neo4j.password)
    );
    this.chUrl = `${config.clickhouse.url}/?user=${config.clickhouse.user}&password=${config.clickhouse.password}`;
    this.chromaBase = `${config.chromadb.url}/api/v2/tenants/default_tenant/databases/default_database`;
    this.chromaCollections = {};
  }

  async init() {
    try {
      await this.neo4jDriver.verifyConnectivity();
    } catch {}
    try {
      const cols = await (await fetch(`${this.chromaBase}/collections`)).json();
      for (const c of cols) this.chromaCollections[c.name] = c.id;
    } catch {}
  }

  async queryClickHouse(sql) {
    try {
      const res = await fetch(`${this.chUrl}&query=${encodeURIComponent(sql + ' FORMAT JSONEachRow')}`);
      const text = await res.text();
      return text.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    } catch { return []; }
  }

  async queryNeo4j(cypher, params = {}) {
    const session = this.neo4jDriver.session();
    try {
      const result = await session.run(cypher, params);
      return result.records.map(r => {
        const obj = {};
        for (const key of r.keys) {
          const val = r.get(key);
          obj[key] = val?.toNumber ? val.toNumber() : val;
        }
        return obj;
      });
    } catch { return []; } finally { await session.close(); }
  }

  async searchChromaDB(collectionName, queryText, nResults = 5) {
    const colId = this.chromaCollections[collectionName];
    if (!colId) return [];
    try {
      const res = await fetch(`${this.chromaBase}/collections/${colId}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query_texts: [queryText], n_results: nResults }),
      });
      const data = await res.json();
      if (!data.ids?.[0]) return [];
      return data.ids[0].map((id, i) => ({
        id,
        document: data.documents?.[0]?.[i] || '',
        metadata: data.metadatas?.[0]?.[i] || {},
        distance: data.distances?.[0]?.[i] || 0,
      }));
    } catch { return []; }
  }

  async getGapAnalysis() {
    const sessionTopics = await this.queryClickHouse(`
      SELECT primary_category, count() as sessions, sum(total_tokens) as tokens
      FROM consumer.sessions
      GROUP BY primary_category ORDER BY sessions DESC LIMIT 20
    `);

    const skillCategories = await this.queryClickHouse(`
      SELECT category, count() as cnt, avg(quality_score) as avg_quality
      FROM consumer.skills
      GROUP BY category ORDER BY cnt DESC
    `);

    const lowQualitySkills = await this.queryClickHouse(`
      SELECT id, name, category, quality_score
      FROM consumer.skills
      WHERE quality_score < 40
      ORDER BY quality_score ASC LIMIT 20
    `);

    const orphanTopics = await this.queryNeo4j(`
      MATCH (t:Topic)
      WHERE NOT (t)<-[:ABOUT_TOPIC]-(:Skill)
      RETURN t.name as topic LIMIT 20
    `);

    const hubSkills = await this.queryNeo4j(`
      MATCH (s:Skill)-[r]-()
      WITH s, count(r) as connections
      ORDER BY connections DESC LIMIT 10
      RETURN s.id as id, s.category as category, connections
    `);

    const isolatedSkills = await this.queryNeo4j(`
      MATCH (s:Skill)
      WHERE NOT (s)-[:ABOUT_TOPIC]->() AND NOT (s)-[:HAS_KEYWORD]->()
      RETURN s.id as id, s.category as category LIMIT 20
    `);

    return { sessionTopics, skillCategories, lowQualitySkills, orphanTopics, hubSkills, isolatedSkills };
  }

  async findSimilarSkills(description) {
    return this.searchChromaDB('skill_chunks', description, 5);
  }

  async close() {
    await this.neo4jDriver.close();
  }
}
