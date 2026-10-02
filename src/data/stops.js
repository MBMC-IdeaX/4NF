/**
 * Kathmandu Valley Key Transit Nodes & Distance Matrix
 */
export const TRANSIT_STOPS = [
  { id: "ratnapark", name: "Ratnapark (Old Buspark)", hub: true },
  { id: "lagankhel", name: "Lagankhel (Lalitpur)", hub: true },
  { id: "koteshwor", name: "Koteshwor", hub: true },
  { id: "kalanki", name: "Kalanki", hub: true },
  { id: "gongabu", name: "Gongabu (New Buspark)", hub: true },
  { id: "chabahil", name: "Chabahil", hub: true },
  { id: "bhaktapur", name: "Bhaktapur (Suryabinayak)", hub: true },
  { id: "balkhu", name: "Balkhu", hub: true },
  { id: "maharajgunj", name: "Maharajgunj", hub: true },
  { id: "airport", name: "TIA (Airport)", hub: false },
  { id: "thamel", name: "Thamel", hub: false },
  { id: "satdobato", name: "Satdobato", hub: true },
  { id: "swyambhu", name: "Swayambhu", hub: false },
  { id: "narayan-gopal", name: "Narayan Gopal Chowk", hub: true },
];

/** Approximate road distances in km between major hubs */
const DISTANCE_MATRIX = {
  "ratnapark-lagankhel": 5.4,
  "ratnapark-koteshwor": 6.8,
  "ratnapark-kalanki": 5.8,
  "ratnapark-gongabu": 4.5,
  "ratnapark-chabahil": 5.2,
  "ratnapark-bhaktapur": 14.2,
  "ratnapark-balkhu": 4.6,
  "ratnapark-maharajgunj": 4.9,
  "koteshwor-lagankhel": 4.8,
  "koteshwor-kalanki": 11.2,
  "koteshwor-bhaktapur": 8.5,
  "koteshwor-gongabu": 12.0,
  "kalanki-gongabu": 6.2,
  "kalanki-lagankhel": 7.5,
  "kalanki-balkhu": 2.4,
  "gongabu-maharajgunj": 2.8,
  "gongabu-chabahil": 6.1,
  "chabahil-koteshwor": 5.9,
  "chabahil-bhaktapur": 12.8,
};

export function estimateDistance(fromName, toName) {
  const normFrom = fromName.toLowerCase().replace(/[^a-z]/g, "");
  const normTo = toName.toLowerCase().replace(/[^a-z]/g, "");

  if (normFrom === normTo) return 1.0;

  // Try direct match or reverse in matrix
  for (const [key, dist] of Object.entries(DISTANCE_MATRIX)) {
    const [a, b] = key.split("-");
    if (
      (normFrom.includes(a) && normTo.includes(b)) ||
      (normFrom.includes(b) && normTo.includes(a))
    ) {
      return dist;
    }
  }

  // Fallback heuristic for arbitrary Kathmandu valley search
  return 6.5;
}
