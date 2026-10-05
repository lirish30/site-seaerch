// Suggestions only: custom types can be added and go straight into the Maps query.
export const TYPE_GROUPS: { name: string; types: string[] }[] = [
  { name: "Home & trade services", types: [
    "plumber", "electrician", "roofer", "HVAC", "landscaper", "general contractor", "remodeling contractor", "painter",
    "flooring contractor", "window installer", "garage door", "fence contractor", "concrete contractor", "pest control",
    "pool service", "tree service", "cleaning service", "moving company", "solar installer", "home inspector"] },
  { name: "Auto", types: ["auto repair", "auto body shop", "car dealership", "tire shop", "towing service", "RV dealer"] },
  { name: "Health & wellness", types: [
    "dentist", "orthodontist", "chiropractor", "physical therapist", "optometrist", "veterinarian", "dermatologist",
    "med spa", "mental health counselor", "pediatrician", "urgent care", "pharmacy", "senior care", "home health care"] },
  { name: "Education", types: [
    "private school", "charter school", "preschool", "daycare", "montessori school", "community college", "university",
    "trade school", "tutoring center", "test prep", "music school", "dance studio", "driving school", "language school",
    "coding bootcamp", "online school", "homeschool co-op", "school district", "college admissions consultant"] },
  { name: "Corporate & professional", types: [
    "law firm", "accounting firm", "CPA", "tax preparer", "financial advisor", "wealth management", "insurance agency",
    "mortgage broker", "bank", "credit union", "staffing agency", "recruiting firm", "executive search", "HR consulting",
    "management consulting", "IT services", "managed service provider", "cybersecurity firm", "software company",
    "marketing agency", "advertising agency", "PR firm", "architecture firm", "engineering firm", "commercial real estate",
    "property management", "commercial construction", "corporate training", "coworking space", "business coaching",
    "translation service", "market research firm", "payroll service", "corporate headquarters"] },
  { name: "Industrial & B2B", types: [
    "manufacturer", "machine shop", "wholesale distributor", "logistics company", "freight broker", "trucking company",
    "warehouse", "commercial printer", "sign company", "packaging supplier", "industrial supply", "equipment rental",
    "janitorial service", "security company"] },
  { name: "Real estate & finance", types: ["real estate agent", "real estate broker", "title company", "appraiser"] },
  { name: "Food & hospitality", types: [
    "restaurant", "cafe", "bakery", "caterer", "brewery", "bar", "hotel", "bed and breakfast", "event venue", "wedding planner"] },
  { name: "Beauty & personal", types: [
    "salon", "barber shop", "spa", "nail salon", "tattoo shop", "gym", "yoga studio", "martial arts studio", "personal trainer"] },
  { name: "Retail", types: ["boutique", "furniture store", "jewelry store", "florist", "pet store", "bike shop", "hardware store", "bookstore"] },
  { name: "Community & other", types: [
    "church", "nonprofit", "funeral home", "photographer", "videographer", "print shop", "art gallery", "theater",
    "storage facility", "self storage", "pet groomer", "dog trainer"] },
];
