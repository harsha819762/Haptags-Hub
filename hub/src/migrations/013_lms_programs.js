'use strict';

// Programmes from lms.haptags.com. Each LMS course has two plans: Internship (the programme's fee)
// and Certificate (certificate_fee). Programmes also keep their LMS category and course link.
// The 43 courses published on 2 Nov 2026 are added from this snapshot, so the server needs no
// network while it starts; Education → Programs & fees → "Sync from LMS" picks up later changes.
// Plain columns only (see 006); every step checks first, so a rerun is safe.

const { fromRow, upsertPrograms } = require('../lib/lms-programs');

// [LMS id, slug, title, category, subtitle, Internship plan ₹, Certificate plan ₹]
const COURSES = [
  ['u2w87bzaj1jdlw7', 'food-technology-internship-training', 'Food Technology', 'Biology & Life Sciences', 'Food processing, quality control, and product development', 2499, 999],
  ['anfmqzkskgejbdr', 'genetic-engineering-internship-training', 'Genetic Engineering Internship Training', 'Biology & Life Sciences', 'CRISPR, gene editing, and recombinant DNA technology', 2499, 999],
  ['r1gj3ta0nrijb61', 'medical-coding-internship-training', 'Medical Coding', 'Biology & Life Sciences', 'ICD, CPT, and HCPCS coding for healthcare billing and records', 2499, 999],
  ['29ttj2viqxnhj9g', 'micro-biology-internship-training', 'Micro Biology', 'Biology & Life Sciences', 'Microbial world, lab techniques, and applied microbiology', 2499, 999],
  ['0akl3a74g9wiigg', 'molecular-biology-internship-training', 'Molecular Biology', 'Biology & Life Sciences', 'DNA, RNA, proteins, and molecular mechanisms of life', 2499, 999],
  ['6rggx4dynlvik0d', 'nanotechnology-internship-training', 'Nanotechnology Internship Training', 'Biology & Life Sciences', 'Nanomaterials, fabrication techniques, and nanotechnology applications', 2499, 999],
  ['q9wrdhap0sllton', 'pharmacovigilance-internship-training', 'Pharmacovigilance', 'Biology & Life Sciences', 'Drug safety monitoring, adverse event reporting, and regulatory compliance', 2499, 999],
  ['kiz8le4926ljyzr', 'construction-planning-internship-training', 'Construction Planning', 'Engineering & Mechanical', 'Project scheduling, resource management, and construction site planning', 2499, 999],
  ['q3igeop5gqwhygt', 'hybrid-electric-vehicles-internship-training', 'Hybrid Electric Vehicles Internship Training', 'Engineering & Mechanical', 'HEV powertrain, battery systems, and EV technology fundamentals', 2499, 999],
  ['wkxtxmlq4ed6sgd', 'ic-engines-internship-training', 'IC Engines Internship Training', 'Engineering & Mechanical', 'Internal combustion engine design, thermodynamics, and diagnostics', 2499, 999],
  ['ig3aaqebsg7tvhs', 'acca-f4-corporate-business-law', 'ACCA F4 (Corporate and Business Law)', 'Finance & Business', 'Company law, contracts, and governance for the ACCA F4 exam', 2499, 999],
  ['ngyjni1znbawq1o', 'business-analytics-internship-training', 'Business Analytics', 'Finance & Business', 'Analytics frameworks and decision-making tools for business leaders', 2499, 999],
  ['xlzlv5zhjd5jzod', 'finance-internship-training', 'Finance Internship Training', 'Finance & Business', 'Financial analysis, valuation, and corporate finance essentials', 2499, 999],
  ['jp1sljjwplnnygp', 'stock-marketing-internship-training', 'Stock Marketing Internship', 'Finance & Business', 'Equity markets, technical analysis, and investment strategies', 2499, 999],
  ['urmhl1t0h58smid', 'human-resource-internship-training', 'Human Resource Internship Training', 'HR', 'Recruitment, performance management, and HR operations', 2499, 999],
  ['zrlz92ew3s0oyp2', 'android-development-internship-training', 'Android Development Internship Training', 'IT & Software', 'Build native Android apps with Kotlin and Android Studio', 2499, 999],
  ['ual4oev4a4am64o', 'apple-ios-app-development-internship-training', 'Apple iOS App Development Internship Training', 'IT & Software', 'Build and ship native iPhone apps with Swift, SwiftUI and Xcode', 2499, 999],
  ['xk06b7enrxx7oe6', 'artificial-intelligence-internship-training', 'Artificial Intelligence Internship Training', 'IT & Software', 'Deep learning, NLP, computer vision, and AI deployment', 2499, 999],
  ['lktc6k9liyykt9v', 'autocad-internship-training', 'AutoCAD Internship Training', 'IT & Software', '2D drafting and 3D modelling with AutoCAD', 2499, 999],
  ['f4oy7f6o5n7jubk', 'aws-internship-training', 'AWS', 'IT & Software', 'Cloud infrastructure, services, and deployment on Amazon Web Services', 2499, 999],
  ['1w0k1d9prvah3wo', 'blockchain-internship-training', 'Blockchain', 'IT & Software', 'Smart contracts, DeFi, and decentralised application development', 2499, 999],
  ['74juyiav7upi34k', 'cloud-computing-internship-training', 'Cloud Computing Internship Training', 'IT & Software', 'Cloud architecture, deployment models, and multi-cloud strategy', 2499, 999],
  ['wc7q37kus1goe96', 'cyber-security-internship-training', 'Cyber Security Internship Training', 'IT & Software', 'Ethical hacking, threat modelling, and secure system design', 2499, 999],
  ['9gvbkh9aj4jxjr3', 'data-analytics-business-analytics-internship-training', 'Data Analytics & Business Analytics Internship Training', 'IT & Software', 'Data-driven decision making with analytics tools and techniques', 2499, 999],
  ['olme7dy8bh57ixl', 'data-science-internship-training', 'Data Science Internship Training', 'IT & Software', 'From raw data to business insight with Python and ML', 2499, 999],
  ['on8ly6hg9zy0yie', 'devops-internship-training', 'DevOps', 'IT & Software', 'CI/CD, Docker, Kubernetes, and cloud deployment in practice', 2499, 999],
  ['a3fob251iz7jkpj', 'embedded-systems-iot-internship-training', 'Embedded Systems and IoT Internship Training', 'IT & Software', 'Microcontrollers, firmware, and IoT system integration', 2499, 999],
  ['cs5xhu4qovbe7jz', 'full-stack-internship-training', 'Full Stack', 'IT & Software', 'End-to-end web development with modern frameworks', 2499, 999],
  ['gmqols4iqy26m2y', 'full-stack-java', 'Full Stack Java', 'IT & Software', 'Build production-grade web apps end-to-end with Java & Spring Boot', 2499, 999],
  ['rnh3mdwfo71x01s', 'generative-ai-internship-training', 'Generative AI Internship Training', 'IT & Software', 'Build real applications with LLMs, prompting, RAG and AI agents', 2499, 999],
  ['3yl34g76dmfsbad', 'iot-internship-training', 'IoT Internship Training', 'IT & Software', 'Internet of Things architecture, protocols, and device programming', 2499, 999],
  ['pp7gobo6k5dyznu', 'java-internship-training', 'Java Internship Training', 'IT & Software', 'Core and advanced Java for real-world application development', 2499, 999],
  ['l1dudcm937wuut5', 'machine-learning-internship-training', 'Machine Learning Internship Training', 'IT & Software', 'Supervised, unsupervised, and reinforcement learning with Python', 2499, 999],
  ['pmyx607b14dka8m', 'pentesting-internship-training', 'Pentesting', 'IT & Software', 'Learn ethical hacking and penetration testing techniques', 2499, 999],
  ['ebyj7qa09jd78v0', 'salesforce-internship-training', 'Salesforce', 'IT & Software', 'CRM development and administration on the Salesforce platform', 2499, 999],
  ['6a60z0zfujesstw', 'sql-internship-training', 'SQL', 'IT & Software', 'Relational databases, querying, and data manipulation with SQL', 2499, 999],
  ['etta9cbfgfr2abz', 'ui-ux-internship-training', 'UI/UX', 'IT & Software', 'Design beautiful, user-centered interfaces from wireframe to prototype', 2499, 999],
  ['61bmph4ho5u4isq', 'vlsi-internship-training', 'VLSI', 'IT & Software', 'VLSI design, simulation, and chip architecture fundamentals', 2499, 999],
  ['7ch0f9qd9xpc9gy', 'web-development-internship-training', 'Web Development Internship Training', 'IT & Software', 'HTML, CSS, JavaScript, and full-stack web development essentials', 2499, 999],
  ['uwwxjcir9ktdw4z', 'digital-marketing-internship-training', 'Digital Marketing Internship Training', 'Marketing', 'SEO, social media, paid ads, and analytics for modern brands', 2499, 999],
  ['en7dere13lyvdtb', 'graphic-designing-internship-training', 'Graphic Designing', 'Marketing', 'Visual communication, brand identity, and design tools for digital media', 2499, 999],
  ['p5gcy1bcmlu2qcu', 'marketing-internship-training', 'Marketing Internship', 'Marketing', 'Marketing strategy, consumer behaviour, and campaign execution', 2499, 999],
  ['exe31zbpdc1ef2d', 'robotics-internship-training', 'Robotics Internship Training', 'Robotics', 'Robot kinematics, sensors, actuators, and ROS programming', 2499, 999],
];

exports.up = async function up(knex) {
  const columns = {
    certificate_fee: (t) => t.bigInteger('certificate_fee').notNullable().defaultTo(0),
    category: (t) => t.string('category', 100),
    lms_id: (t) => t.string('lms_id', 30),
    lms_slug: (t) => t.string('lms_slug', 190),
  };
  const missing = [];
  for (const col of Object.keys(columns)) if (!(await knex.schema.hasColumn('programs', col))) missing.push(col);
  if (missing.length) {
    await knex.schema.alterTable('programs', (t) => {
      for (const col of missing) columns[col](t);
      if (missing.includes('lms_id')) t.unique(['lms_id']);
    });
  }
  await upsertPrograms(knex, COURSES.map(fromRow));
};

// The columns stay: dropping columns can rebuild the table on SQLite (see 006).
exports.down = async function down() {};
