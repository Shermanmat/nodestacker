import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';

const dbPath = process.env.DATABASE_PATH || 'nodestacker.db';
const db = new Database(dbPath);

// Apply 0018 migration if needed
const sql0018 = readFileSync('./src/db/migrations/0018_category_parent.sql', 'utf-8');
const hash0018 = createHash('sha256').update(sql0018).digest('hex');
const existing0018 = db.prepare('SELECT * FROM __drizzle_migrations WHERE hash = ?').get(hash0018);
if (!existing0018) {
  db.prepare('ALTER TABLE investor_categories ADD COLUMN parent_id integer REFERENCES investor_categories(id)').run();
  db.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run(hash0018, 1773400000000);
  console.log('Applied 0018 migration (parent_id)');
} else {
  console.log('0018 already applied');
}

// Delete existing sector categories (preserve stage/persona)
db.prepare("DELETE FROM investor_category_assignments WHERE category_id IN (SELECT id FROM investor_categories WHERE type = 'sector')").run();
db.prepare("DELETE FROM founder_category_assignments WHERE category_id IN (SELECT id FROM investor_categories WHERE type = 'sector')").run();
db.prepare("DELETE FROM investor_categories WHERE type = 'sector'").run();

const now = new Date().toISOString();

const sectors: { name: string; color: string; subcategories: string[] }[] = [
  {
    name: 'Financial Services (Fintech)',
    color: 'amber',
    subcategories: ['Payments', 'Banking / Neobanks', 'Lending', 'Wealthtech', 'Crypto / Web3', 'Insurance (Insurtech)', 'Financial infrastructure'],
  },
  {
    name: 'Enterprise Software (SaaS)',
    color: 'blue',
    subcategories: ['CRM / sales tools', 'Marketing tech', 'HR / payroll', 'Collaboration / productivity', 'Vertical SaaS'],
  },
  {
    name: 'Artificial Intelligence',
    color: 'purple',
    subcategories: ['AI infrastructure', 'Foundation models', 'AI developer tools', 'Vertical AI', 'AI agents / automation'],
  },
  {
    name: 'Infrastructure / Developer Tools',
    color: 'indigo',
    subcategories: ['Cloud infrastructure', 'Databases', 'DevOps', 'API platforms', 'Developer tooling'],
  },
  {
    name: 'Cybersecurity',
    color: 'red',
    subcategories: ['Cloud security', 'Identity management', 'Fraud detection', 'Compliance', 'Threat intelligence'],
  },
  {
    name: 'Healthcare / Life Sciences',
    color: 'pink',
    subcategories: ['Digital health', 'Biotech', 'Therapeutics', 'Medical devices', 'Diagnostics'],
  },
  {
    name: 'Consumer',
    color: 'orange',
    subcategories: ['Social', 'Mobile apps', 'Consumer platforms', 'Creator economy', 'Gaming'],
  },
  {
    name: 'Commerce',
    color: 'amber',
    subcategories: ['Ecommerce', 'Marketplaces', 'DTC brands', 'Retail tech'],
  },
  {
    name: 'Climate / Energy',
    color: 'green',
    subcategories: ['Clean energy', 'Batteries', 'Carbon removal', 'Energy software', 'Climate infrastructure'],
  },
  {
    name: 'HardTech / DeepTech',
    color: 'red',
    subcategories: ['Robotics', 'Advanced manufacturing', 'Semiconductors', 'Aerospace', 'Materials science'],
  },
  {
    name: 'Defense / Government',
    color: 'gray',
    subcategories: ['Defense tech', 'Military AI', 'Border security', 'Govtech', 'Intelligence systems'],
  },
  {
    name: 'Transportation / Mobility',
    color: 'teal',
    subcategories: ['Logistics', 'Autonomous vehicles', 'Aviation', 'Fleet software'],
  },
  {
    name: 'Real Estate / Construction',
    color: 'orange',
    subcategories: ['Proptech', 'Construction tech', 'Building management', 'Real estate marketplaces'],
  },
  {
    name: 'Agriculture / Food',
    color: 'green',
    subcategories: ['Agtech', 'Food supply chains', 'Alternative proteins', 'Farming robotics'],
  },
  {
    name: 'Education / Work',
    color: 'blue',
    subcategories: ['Edtech', 'Workforce training', 'Hiring / recruiting', 'HR tech'],
  },
];

const insertCategory = db.prepare('INSERT INTO investor_categories (name, type, color, parent_id, created_at) VALUES (?, ?, ?, ?, ?)');

let count = 0;
for (const sector of sectors) {
  // Insert top-level sector
  const result = insertCategory.run(sector.name, 'sector', sector.color, null, now);
  const parentId = result.lastInsertRowid;
  count++;

  // Insert subcategories with parent_id
  for (const sub of sector.subcategories) {
    insertCategory.run(sub, 'sector', sector.color, parentId, now);
    count++;
  }
}

console.log(`Seeded ${count} sector categories across ${sectors.length} top-level sectors.`);
db.close();
