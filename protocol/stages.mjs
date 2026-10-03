// The stages (fare stops) of each route, in running order.
//
// Bhada does not set fares. A bus fare in the valley is a stage fare: the
// regulator's table says what a ride from one stage to another costs. Bhada's
// part is to work out, from the bus's GPS, which stage a passenger got on at
// and which they got off at, and to apply that table.
//
// `chainM` is the road distance from the first stage. It is used to find the
// stage a bus is nearest, and to fall back on when a door has no GPS fix at
// the moment a passenger gets off.
//
// These positions are landmarks, not surveyed stage posts. A real deployment
// loads the route permit's stage list; nothing in the code assumes seven.

export const ROUTE_STAGES = {
  R11: [
    { code: 'RATNAPARK', ne: 'रत्नपार्क', en: 'Ratna Park', lat: 27.7045, lon: 85.3145, chainM: 0 },
    { code: 'SINGHADURBAR', ne: 'सिंहदरबार', en: 'Singha Durbar', lat: 27.6975, lon: 85.3230, chainM: 1500 },
    { code: 'MAITIGHAR', ne: 'माइतीघर', en: 'Maitighar', lat: 27.6928, lon: 85.3222, chainM: 2200 },
    { code: 'THAPATHALI', ne: 'थापाथली', en: 'Thapathali', lat: 27.6905, lon: 85.3175, chainM: 2900 },
    { code: 'NEWBANESHWOR', ne: 'नयाँ बानेश्वर', en: 'New Baneshwor', lat: 27.6893, lon: 85.3400, chainM: 5300 },
    { code: 'TINKUNE', ne: 'तिनकुने', en: 'Tinkune', lat: 27.6835, lon: 85.3490, chainM: 6600 },
    { code: 'KOTESHWOR', ne: 'कोटेश्वर', en: 'Koteshwor', lat: 27.6785, lon: 85.3495, chainM: 7500 },
  ],
};
