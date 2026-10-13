// ===========================================================================
// The skill taxonomy: what K9 is allowed to say a student is good or bad at.
//
// Deliberately a fixed, curated list rather than whatever free-form string an
// OCR pass produced. Three reasons:
//
//   1. A profile is only useful if the same skill has the same name every
//      time. "Balancing equations", "balancing chemical equations" and
//      "equation balancing" as three separate weak topics is a worse answer
//      than one.
//   2. It is the closed vocabulary the model mapper chooses from. A model
//      that can only return a code from this list cannot invent a skill, and
//      cannot quietly drift the taxonomy over a term.
//   3. A head teacher comparing Form 3 across four streams needs the streams
//      to be counting the same thing.
//
// Scoped to the Tanzanian NECTA O-level subjects K9 ships with. `keywords`
// are what the deterministic mapper matches on — cheap, offline, and right
// most of the time; the model only ever sees the questions they miss.
//
// Adding a skill is safe at any time: it seeds on boot, existing observations
// keep their mapping, and nothing is renamed under a student's feet.
// ===========================================================================

export type SkillSeed = {
  code: string;
  name: string;
  strand: string;
  form_level?: string;
  keywords: string[];
};

export const SKILL_TAXONOMY: Record<string, SkillSeed[]> = {
  Mathematics: [
    { code: "MATH.NUM.FRACTIONS", name: "Fractions and decimals", strand: "Number", keywords: ["fraction", "decimal", "numerator", "denominator", "simplify the fraction", "recurring"] },
    { code: "MATH.NUM.RATIO", name: "Ratio and proportion", strand: "Number", keywords: ["ratio", "proportion", "share in the ratio", "scale factor", "per cent", "percentage"] },
    { code: "MATH.ALG.LINEAR", name: "Linear equations", strand: "Algebra", keywords: ["solve for x", "linear equation", "simultaneous", "substitute the value"] },
    { code: "MATH.ALG.REARRANGE", name: "Algebraic rearrangement", strand: "Algebra", keywords: ["make x the subject", "rearrange", "change the subject", "transpose", "factorise", "expand the bracket"] },
    { code: "MATH.ALG.QUADRATIC", name: "Quadratic equations", strand: "Algebra", keywords: ["quadratic", "x squared", "completing the square", "roots of the equation", "discriminant"] },
    { code: "MATH.ALG.SEQUENCE", name: "Sequences and series", strand: "Algebra", keywords: ["sequence", "nth term", "arithmetic progression", "geometric progression", "common difference"] },
    { code: "MATH.GEO.SHAPES", name: "Perimeter, area and volume", strand: "Geometry", keywords: ["perimeter", "area of", "volume of", "surface area", "circumference", "cylinder", "cuboid"] },
    { code: "MATH.GEO.ANGLES", name: "Angles and geometric reasoning", strand: "Geometry", keywords: ["angle", "parallel lines", "polygon", "congruent", "similar triangles", "bisector"] },
    { code: "MATH.GEO.TRIG", name: "Trigonometry", strand: "Geometry", keywords: ["sine", "cosine", "tangent", "trigonometr", "right-angled triangle", "hypotenuse", "bearing"] },
    { code: "MATH.DATA.GRAPHS", name: "Graph interpretation", strand: "Data", keywords: ["graph", "plot the points", "gradient", "axes", "straight line", "read from the graph", "intercept"] },
    { code: "MATH.DATA.STATS", name: "Statistics and averages", strand: "Data", keywords: ["mean", "median", "mode", "frequency table", "histogram", "range of the data"] },
    { code: "MATH.DATA.PROB", name: "Probability", strand: "Data", keywords: ["probability", "likelihood", "at random", "outcomes"] },
  ],
  Physics: [
    { code: "PHY.MEAS.UNITS", name: "Measurement and units", strand: "Measurement", keywords: ["si unit", "measure", "vernier", "micrometer", "significant figure", "density"] },
    { code: "PHY.MECH.FORCES", name: "Forces and Newton's laws", strand: "Mechanics", keywords: ["force", "newton's", "acceleration", "friction", "mass times", "resultant", "momentum"] },
    { code: "PHY.MECH.ENERGY", name: "Work, energy and power", strand: "Mechanics", keywords: ["work done", "kinetic energy", "potential energy", "power", "joule", "watt", "efficiency"] },
    { code: "PHY.MECH.PRESSURE", name: "Pressure in solids and fluids", strand: "Mechanics", keywords: ["pressure", "pascal", "barometer", "archimedes", "upthrust", "hydraulic"] },
    { code: "PHY.HEAT.THERMAL", name: "Heat and temperature", strand: "Thermal", keywords: ["temperature", "specific heat", "thermal", "expansion", "latent heat", "conduction", "convection"] },
    { code: "PHY.WAVE.LIGHT", name: "Light and reflection", strand: "Waves", keywords: ["reflection", "refraction", "lens", "mirror", "ray diagram", "focal length"] },
    { code: "PHY.WAVE.SOUND", name: "Sound and waves", strand: "Waves", keywords: ["wavelength", "frequency", "amplitude", "sound wave", "echo", "vibration"] },
    { code: "PHY.ELEC.CURRENT", name: "Current electricity", strand: "Electricity", keywords: ["current", "voltage", "resistance", "ohm", "circuit", "ammeter", "voltmeter", "series and parallel"] },
    { code: "PHY.ELEC.MAGNET", name: "Magnetism and electromagnetism", strand: "Electricity", keywords: ["magnet", "magnetic field", "solenoid", "electromagnet", "induction", "transformer"] },
  ],
  Chemistry: [
    { code: "CHEM.MATTER.STATES", name: "Matter and its states", strand: "Matter", keywords: ["state of matter", "melting", "boiling", "sublimation", "diffusion", "kinetic theory"] },
    { code: "CHEM.ATOM.STRUCTURE", name: "Atomic structure", strand: "Atoms", keywords: ["atom", "proton", "neutron", "electron", "isotope", "electronic configuration", "atomic number"] },
    { code: "CHEM.ATOM.PERIODIC", name: "The periodic table", strand: "Atoms", keywords: ["periodic table", "group", "period", "alkali metal", "halogen", "noble gas"] },
    { code: "CHEM.BOND.BONDING", name: "Chemical bonding", strand: "Bonding", keywords: ["ionic bond", "covalent", "metallic bond", "lattice", "valency", "electron sharing"] },
    { code: "CHEM.REACT.BALANCE", name: "Balancing chemical equations", strand: "Reactions", keywords: ["balance the equation", "balanced equation", "chemical equation", "reactants and products", "state symbol"] },
    { code: "CHEM.REACT.MOLE", name: "The mole concept", strand: "Reactions", keywords: ["mole", "molar mass", "avogadro", "concentration", "titration", "relative atomic mass", "stoichiometr"] },
    { code: "CHEM.REACT.ACIDBASE", name: "Acids, bases and salts", strand: "Reactions", keywords: ["acid", "base", "alkali", "salt", "ph", "neutralisation", "indicator"] },
    { code: "CHEM.REACT.REDOX", name: "Oxidation and reduction", strand: "Reactions", keywords: ["oxidation", "reduction", "redox", "oxidising agent", "electrolysis", "rusting"] },
    { code: "CHEM.APPLIED.WATER", name: "Water and its treatment", strand: "Applied", keywords: ["hard water", "water treatment", "soap", "purification", "chlorination"] },
  ],
  Biology: [
    { code: "BIO.CELL.STRUCTURE", name: "Cell structure", strand: "Cells", keywords: ["cell", "nucleus", "cytoplasm", "membrane", "chloroplast", "mitochondri", "microscope"] },
    { code: "BIO.CLASS.TAXONOMY", name: "Classification of living things", strand: "Diversity", keywords: ["classification", "kingdom", "species", "binomial", "taxonom", "dichotomous key"] },
    { code: "BIO.NUTR.DIGEST", name: "Nutrition and digestion", strand: "Nutrition", keywords: ["digestion", "enzyme", "nutrient", "vitamin", "balanced diet", "alimentary"] },
    { code: "BIO.PLANT.TRANSPORT", name: "Transport in plants", strand: "Plants", keywords: ["xylem", "phloem", "transpiration", "root hair", "osmosis in plants", "stomata"] },
    { code: "BIO.PLANT.PHOTO", name: "Photosynthesis", strand: "Plants", keywords: ["photosynthesis", "chlorophyll", "light energy", "starch test"] },
    { code: "BIO.RESP.RESPIRATION", name: "Respiration", strand: "Physiology", keywords: ["respiration", "aerobic", "anaerobic", "breathing", "lungs", "gaseous exchange"] },
    { code: "BIO.GEN.GENETICS", name: "Genetics and inheritance", strand: "Genetics", keywords: ["gene", "chromosome", "dominant", "recessive", "inheritance", "punnett", "genotype", "dna"] },
    { code: "BIO.REP.REPRODUCTION", name: "Reproduction", strand: "Physiology", keywords: ["reproduction", "fertilisation", "gamete", "pollination", "menstrual", "zygote"] },
    { code: "BIO.HEALTH.DISEASE", name: "Health and disease", strand: "Health", keywords: ["disease", "pathogen", "immunity", "malaria", "hiv", "vaccination", "hygiene"] },
  ],
  Geography: [
    { code: "GEO.SKILL.MAPS", name: "Map reading", strand: "Skills", keywords: ["map", "scale", "grid reference", "contour", "bearing", "key of the map", "sketch map"] },
    { code: "GEO.SKILL.STATS", name: "Geographical statistics and graphs", strand: "Skills", keywords: ["bar graph", "pie chart", "population pyramid", "interpret the data"] },
    { code: "GEO.PHYS.EARTH", name: "Structure of the earth", strand: "Physical", keywords: ["earth's crust", "plate", "earthquake", "volcan", "rift valley", "rock type"] },
    { code: "GEO.PHYS.CLIMATE", name: "Weather and climate", strand: "Physical", keywords: ["climate", "rainfall", "temperature range", "weather", "humidity", "monsoon"] },
    { code: "GEO.PHYS.SOIL", name: "Soil and vegetation", strand: "Physical", keywords: ["soil", "erosion", "vegetation", "savanna", "forest"] },
    { code: "GEO.HUMAN.POP", name: "Population and settlement", strand: "Human", keywords: ["population", "settlement", "migration", "urban", "census", "density of population"] },
    { code: "GEO.HUMAN.ECON", name: "Economic activity in Tanzania", strand: "Human", keywords: ["mining", "industry", "agriculture", "tourism", "fishing", "trade"] },
    { code: "GEO.HUMAN.TRANSPORT", name: "Transport and communication", strand: "Human", keywords: ["transport", "railway", "harbour", "road network", "communication"] },
  ],
  History: [
    { code: "HIST.EARLY.COMMUNITIES", name: "Early communities of East Africa", strand: "Pre-colonial", keywords: ["early man", "iron age", "bantu", "stone age", "early communities"] },
    { code: "HIST.TRADE.LONGDIST", name: "Long-distance and Indian Ocean trade", strand: "Pre-colonial", keywords: ["trade route", "caravan", "indian ocean", "swahili coast", "slave trade", "ivory"] },
    { code: "HIST.COL.COLONIALISM", name: "Colonialism in Tanganyika", strand: "Colonial", keywords: ["colonial", "german east africa", "berlin conference", "indirect rule", "settler"] },
    { code: "HIST.COL.RESISTANCE", name: "Resistance and the Maji Maji war", strand: "Colonial", keywords: ["maji maji", "resistance", "hehe", "abushiri", "rebellion"] },
    { code: "HIST.IND.STRUGGLE", name: "The struggle for independence", strand: "Independence", keywords: ["tanu", "independence", "nyerere", "uhuru", "nationalism"] },
    { code: "HIST.IND.ARUSHA", name: "The Arusha Declaration and ujamaa", strand: "Independence", keywords: ["arusha declaration", "ujamaa", "self-reliance", "villagisation", "socialism"] },
    { code: "HIST.IND.UNION", name: "The union of Tanganyika and Zanzibar", strand: "Independence", keywords: ["union", "zanzibar revolution", "united republic", "1964"] },
    { code: "HIST.SKILL.ESSAY", name: "Historical essay structure", strand: "Skills", keywords: ["essay", "introduction and conclusion", "discuss", "explain the causes", "paragraph"] },
  ],
  Civics: [
    { code: "CIV.GOV.CONSTITUTION", name: "The constitution of Tanzania", strand: "Government", keywords: ["constitution", "bill of rights", "amendment", "rule of law"] },
    { code: "CIV.GOV.ARMS", name: "The three arms of government", strand: "Government", keywords: ["executive", "legislature", "judiciary", "parliament", "separation of powers"] },
    { code: "CIV.GOV.ELECTIONS", name: "Elections and democracy", strand: "Government", keywords: ["election", "democracy", "vote", "political party", "candidate"] },
    { code: "CIV.SOC.RIGHTS", name: "Human rights and responsibilities", strand: "Society", keywords: ["human rights", "responsibilit", "gender", "child rights", "discrimination"] },
    { code: "CIV.SOC.VALUES", name: "National symbols and values", strand: "Society", keywords: ["national anthem", "flag", "national symbol", "culture", "ethic"] },
  ],
  English: [
    { code: "ENG.GRAM.TENSES", name: "Tenses", strand: "Grammar", keywords: ["tense", "past simple", "present perfect", "future", "verb form"] },
    { code: "ENG.GRAM.STRUCTURE", name: "Sentence structure and agreement", strand: "Grammar", keywords: ["subject-verb", "agreement", "clause", "preposition", "article", "conjunction"] },
    { code: "ENG.GRAM.SPEECH", name: "Direct and indirect speech", strand: "Grammar", keywords: ["direct speech", "indirect speech", "reported speech", "quotation"] },
    { code: "ENG.READ.COMPREHENSION", name: "Comprehension", strand: "Reading", keywords: ["comprehension", "passage", "according to the passage", "what does the writer"] },
    { code: "ENG.READ.VOCAB", name: "Vocabulary in context", strand: "Reading", keywords: ["meaning of the word", "synonym", "antonym", "vocabulary", "as used in the passage"] },
    { code: "ENG.WRITE.ESSAY", name: "Essay and composition structure", strand: "Writing", keywords: ["composition", "essay", "paragraph", "introduction", "conclusion", "write about"] },
    { code: "ENG.WRITE.LETTER", name: "Letter and report writing", strand: "Writing", keywords: ["letter", "formal letter", "report writing", "address", "salutation"] },
  ],
  Kiswahili: [
    { code: "KIS.SARUFI.NGELI", name: "Ngeli za nomino", strand: "Sarufi", keywords: ["ngeli", "nomino", "upatanisho"] },
    { code: "KIS.SARUFI.VITENZI", name: "Vitenzi na nyakati", strand: "Sarufi", keywords: ["kitenzi", "vitenzi", "nyakati", "wakati uliopita", "kauli"] },
    { code: "KIS.MSAMIATI.METHALI", name: "Methali na misemo", strand: "Msamiati", keywords: ["methali", "misemo", "nahau", "maana ya methali"] },
    { code: "KIS.UFAHAMU.UFAHAMU", name: "Ufahamu", strand: "Ufahamu", keywords: ["ufahamu", "kifungu", "soma kifungu"] },
    { code: "KIS.UTUNGAJI.INSHA", name: "Utungaji wa insha", strand: "Utungaji", keywords: ["insha", "utungaji", "andika insha", "barua"] },
  ],
  "Computer Studies": [
    { code: "CS.HW.HARDWARE", name: "Computer hardware", strand: "Systems", keywords: ["hardware", "cpu", "input device", "output device", "storage device", "ram"] },
    { code: "CS.SW.OS", name: "Operating systems and software", strand: "Systems", keywords: ["operating system", "software", "file management", "application"] },
    { code: "CS.APP.SPREADSHEET", name: "Spreadsheets", strand: "Applications", keywords: ["spreadsheet", "formula", "cell reference", "excel", "worksheet"] },
    { code: "CS.NET.INTERNET", name: "The internet and online safety", strand: "Networks", keywords: ["internet", "network", "email", "browser", "online safety", "password"] },
    { code: "CS.PROG.ALGORITHMS", name: "Algorithms and flowcharts", strand: "Programming", keywords: ["algorithm", "flowchart", "pseudocode", "loop", "sequence of steps"] },
  ],
};

/**
 * Why a mark was lost. Distinguishing these is what makes a profile
 * actionable: a student who understands balancing equations and keeps
 * dropping arithmetic needs drill, and a student who has never grasped it
 * needs re-teaching. A bare "wrong" cannot tell a teacher which.
 */
export const ERROR_TYPES = [
  "concept", // has not understood the idea
  "calculation", // right method, arithmetic slip
  "careless", // knew it, mis-copied or mis-read the question
  "incomplete", // correct as far as it goes, stopped early
  "terminology", // right idea, wrong or imprecise vocabulary
  "formula", // used the wrong formula or law
  "reasoning", // steps do not follow, weak argument or justification
  "language", // meaning lost to spelling, grammar or expression
  "unanswered", // nothing attempted
] as const;

export type ErrorType = (typeof ERROR_TYPES)[number];

export const ERROR_LABELS: Record<ErrorType, string> = {
  concept: "Concept not understood",
  calculation: "Calculation slip",
  careless: "Careless mistake",
  incomplete: "Incomplete answer",
  terminology: "Wrong terminology",
  formula: "Wrong formula",
  reasoning: "Weak reasoning",
  language: "Language got in the way",
  unanswered: "Not attempted",
};

/** Every subject the taxonomy covers. */
export const TAXONOMY_SUBJECTS = Object.keys(SKILL_TAXONOMY);

/** Total seeded skills — used by the seeding log and the tests. */
export function taxonomySize(): number {
  return Object.values(SKILL_TAXONOMY).reduce((n, list) => n + list.length, 0);
}
