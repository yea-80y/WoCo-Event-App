// Pantone Solid Coated → approximate sRGB hex lookup.
//
// IMPORTANT: Pantone is a proprietary spot-colour system. These hex values are
// *approximations* in sRGB, drawn from publicly-known community references.
// They are intended as a starting point for screen design only — never use them
// to spec print runs. The UI surfaces this caveat to the user.
//
// Curated subset (~220 codes) covering the most commonly-requested swatches.
// Extend over time; the lookup function tolerates "PMS 286", "286 C", "286" etc.

export interface PantoneEntry { code: string; hex: string; name?: string }

export const PANTONE_COATED: PantoneEntry[] = [
  // Yellows
  { code: '100',  hex: '#F5E96E' },
  { code: '101',  hex: '#F7E859' },
  { code: '102',  hex: '#FCE300' },
  { code: '103',  hex: '#C6A300' },
  { code: '105',  hex: '#6E5610' },
  { code: '106',  hex: '#F9E64F' },
  { code: '107',  hex: '#FBE122' },
  { code: '108',  hex: '#FBD500' },
  { code: '109',  hex: '#FFCD00' },
  { code: '110',  hex: '#DAA900' },
  { code: '113',  hex: '#FBDD63' },
  { code: '114',  hex: '#FBD955' },
  { code: '115',  hex: '#FBD349' },
  { code: '116',  hex: '#FFCD00' },
  { code: '117',  hex: '#C99700' },
  { code: '118',  hex: '#AD841F' },
  { code: '120',  hex: '#F9D979' },
  { code: '121',  hex: '#FAD163' },
  { code: '122',  hex: '#FACD49' },
  { code: '123',  hex: '#FFC72C' },
  { code: '124',  hex: '#EAAA00' },
  { code: '125',  hex: '#B58500' },
  { code: '127',  hex: '#F1D77E' },
  { code: '129',  hex: '#F1C400' },
  { code: '130',  hex: '#F2A900' },
  { code: '131',  hex: '#CC8A00' },
  { code: '136',  hex: '#FFC56E' },
  { code: '137',  hex: '#FFA300' },
  { code: '138',  hex: '#D57800' },
  { code: '139',  hex: '#AF6D04' },

  // Oranges
  { code: '143',  hex: '#EFB549' },
  { code: '144',  hex: '#ED8B00' },
  { code: '151',  hex: '#FF8200' },
  { code: '158',  hex: '#E57200', name: 'Pumpkin' },
  { code: '159',  hex: '#CB6015' },
  { code: '165',  hex: '#FF6900' },
  { code: '166',  hex: '#E35205' },
  { code: '172',  hex: '#FA4616' },
  { code: '173',  hex: '#CF4520' },
  { code: '179',  hex: '#E03C31' },

  // Reds
  { code: '185',  hex: '#E4002B' },
  { code: '186',  hex: '#C8102E' },
  { code: '187',  hex: '#A6192E' },
  { code: '188',  hex: '#76232F' },
  { code: '192',  hex: '#E40046' },
  { code: '199',  hex: '#D50032' },
  { code: '200',  hex: '#BA0C2F' },
  { code: '201',  hex: '#9D2235' },
  { code: '202',  hex: '#862633' },
  { code: '203',  hex: '#ECB3CB' },
  { code: '204',  hex: '#E782A9' },
  { code: '205',  hex: '#E0457B' },
  { code: '206',  hex: '#CE0F69' },
  { code: '207',  hex: '#A20067' },
  { code: '208',  hex: '#7C2855' },
  { code: '209',  hex: '#6A1A41' },
  { code: '213',  hex: '#EF3E76' },
  { code: '214',  hex: '#E0008C' },
  { code: '219',  hex: '#DA1884' },

  // Magenta / Pink
  { code: '226',  hex: '#D0006F' },
  { code: '227',  hex: '#A50050' },
  { code: '228',  hex: '#80225F' },
  { code: '232',  hex: '#E89CAE' },
  { code: '233',  hex: '#C6007E' },
  { code: '234',  hex: '#A50050' },
  { code: '235',  hex: '#8A1538' },
  { code: '236',  hex: '#EAA6BE' },
  { code: '238',  hex: '#E04F9B' },
  { code: '240',  hex: '#B2348B' },
  { code: '241',  hex: '#93268F' },

  // Purples
  { code: '248',  hex: '#A93D96' },
  { code: '252',  hex: '#8031A7' },
  { code: '253',  hex: '#6E2585' },
  { code: '254',  hex: '#642667' },
  { code: '258',  hex: '#73489F' },
  { code: '259',  hex: '#62359F' },
  { code: '265',  hex: '#7F35B2' },
  { code: '266',  hex: '#5F249F' },
  { code: '267',  hex: '#5F249F' },
  { code: '268',  hex: '#582C83' },
  { code: '269',  hex: '#512D6D' },
  { code: '270',  hex: '#9595D2' },
  { code: '272',  hex: '#7474C1' },
  { code: '273',  hex: '#1E22AA' },
  { code: '274',  hex: '#1B1378' },
  { code: '275',  hex: '#1B1361' },
  { code: '276',  hex: '#21134E' },

  // Blues
  { code: '279',  hex: '#418FDE' },
  { code: '280',  hex: '#012169' },
  { code: '281',  hex: '#00205B' },
  { code: '282',  hex: '#041E42' },
  { code: '285',  hex: '#0072CE' },
  { code: '286',  hex: '#0033A0' },
  { code: '287',  hex: '#003087' },
  { code: '288',  hex: '#00205B' },
  { code: '289',  hex: '#0C2340' },
  { code: '290',  hex: '#B9D9EB' },
  { code: '291',  hex: '#9BCBEB' },
  { code: '292',  hex: '#6CACE4' },
  { code: '293',  hex: '#003DA5' },
  { code: '294',  hex: '#002F6C' },
  { code: '295',  hex: '#002855' },
  { code: '296',  hex: '#041E42' },
  { code: '297',  hex: '#71C5E8' },
  { code: '299',  hex: '#00A3E0' },
  { code: '300',  hex: '#005EB8' },
  { code: '301',  hex: '#004B87' },
  { code: '302',  hex: '#003B5C' },
  { code: '303',  hex: '#003049' },
  { code: '304',  hex: '#9ADBE8' },
  { code: '305',  hex: '#59CBE8' },
  { code: '306',  hex: '#00B5E2' },
  { code: '307',  hex: '#00609C' },

  // Cyans / Teals
  { code: '308',  hex: '#00587C' },
  { code: '309',  hex: '#003B49' },
  { code: '310',  hex: '#6AD1E3' },
  { code: '311',  hex: '#0BB8E8' },
  { code: '312',  hex: '#00A9E0' },
  { code: '313',  hex: '#0095C8' },
  { code: '314',  hex: '#00789C' },
  { code: '315',  hex: '#005776' },
  { code: '316',  hex: '#004250' },
  { code: '320',  hex: '#009CA6' },
  { code: '321',  hex: '#008C95' },
  { code: '322',  hex: '#007681' },
  { code: '323',  hex: '#005E5D' },

  // Greens
  { code: '326',  hex: '#00B2A9' },
  { code: '327',  hex: '#008675' },
  { code: '328',  hex: '#00685E' },
  { code: '329',  hex: '#00564B' },
  { code: '330',  hex: '#13322B' },
  { code: '332',  hex: '#A9E2D0' },
  { code: '333',  hex: '#43D5C1' },
  { code: '334',  hex: '#009775' },
  { code: '335',  hex: '#00664F' },
  { code: '336',  hex: '#00563F' },
  { code: '339',  hex: '#00B388' },
  { code: '340',  hex: '#009A44' },
  { code: '341',  hex: '#00843D' },
  { code: '342',  hex: '#006A4D' },
  { code: '343',  hex: '#115740' },
  { code: '347',  hex: '#009A44' },
  { code: '348',  hex: '#00843D' },
  { code: '349',  hex: '#046A38' },
  { code: '350',  hex: '#234F1E' },
  { code: '354',  hex: '#00B140' },
  { code: '355',  hex: '#009639' },
  { code: '356',  hex: '#007A33' },
  { code: '357',  hex: '#215732' },
  { code: '361',  hex: '#43B02A' },
  { code: '362',  hex: '#4A9462' },
  { code: '363',  hex: '#3D8F2F' },
  { code: '364',  hex: '#4F7B27' },
  { code: '368',  hex: '#78BE20' },
  { code: '369',  hex: '#509E2F' },
  { code: '370',  hex: '#658D1B' },
  { code: '371',  hex: '#54652E' },
  { code: '375',  hex: '#97D700' },
  { code: '376',  hex: '#84BD00' },
  { code: '377',  hex: '#7A9A01' },
  { code: '378',  hex: '#54582A' },

  // Warm / earthy / browns
  { code: '380',  hex: '#D7DF23' },
  { code: '381',  hex: '#CEDC00' },
  { code: '382',  hex: '#C4D600' },
  { code: '384',  hex: '#A4B600' },
  { code: '402',  hex: '#BFB8AF' },
  { code: '404',  hex: '#857363' },
  { code: '405',  hex: '#6A5F31' },
  { code: '411',  hex: '#5F4B3B' },
  { code: '413',  hex: '#BCBEB1' },
  { code: '418',  hex: '#5B6770' },
  { code: '422',  hex: '#9EA2A2' },
  { code: '424',  hex: '#707372' },
  { code: '425',  hex: '#54585A' },
  { code: '426',  hex: '#1D252D' },
  { code: '430',  hex: '#7C878E' },
  { code: '431',  hex: '#5B6770' },
  { code: '432',  hex: '#333F48' },
  { code: '433',  hex: '#1D252D' },
  { code: '434',  hex: '#CEC4C0' },
  { code: '437',  hex: '#A7A296' },
  { code: '440',  hex: '#473729' },
  { code: '441',  hex: '#CDD3CB' },
  { code: '444',  hex: '#7E94A5' },
  { code: '447',  hex: '#3D4543' },
  { code: '448',  hex: '#4A412A' },
  { code: '454',  hex: '#B5A642' },
  { code: '462',  hex: '#7C6E58' },
  { code: '464',  hex: '#A67B5B' },
  { code: '465',  hex: '#BAA77D' },
  { code: '466',  hex: '#C1A875' },
  { code: '467',  hex: '#B89D6F' },
  { code: '469',  hex: '#693F23' },
  { code: '470',  hex: '#A6631B' },
  { code: '471',  hex: '#9D4815' },
  { code: '472',  hex: '#E59E6D' },
  { code: '476',  hex: '#5C462B' },
  { code: '477',  hex: '#4E3629' },
  { code: '478',  hex: '#693F23' },
  { code: '484',  hex: '#9A3324' },
  { code: '485',  hex: '#DA291C' },
  { code: '486',  hex: '#E8927C' },
  { code: '492',  hex: '#7B2C3B' },
  { code: '498',  hex: '#5D2A2C' },

  // Process / spot specials
  { code: 'Yellow C',           hex: '#FEDD00', name: 'Process Yellow' },
  { code: 'Orange 021 C',       hex: '#FE5000' },
  { code: 'Warm Red C',         hex: '#F9423A' },
  { code: 'Red 032 C',          hex: '#EF3340' },
  { code: 'Rubine Red C',       hex: '#CE0058' },
  { code: 'Rhodamine Red C',    hex: '#E10098' },
  { code: 'Pink C',             hex: '#D62598' },
  { code: 'Purple C',           hex: '#BB29BB' },
  { code: 'Violet C',           hex: '#440099' },
  { code: 'Blue 072 C',         hex: '#10069F' },
  { code: 'Reflex Blue C',      hex: '#001489' },
  { code: 'Process Blue C',     hex: '#0085CA' },
  { code: 'Process Cyan C',     hex: '#00B5E2' },
  { code: 'Green C',            hex: '#00AB84', name: 'Process Green' },
  { code: 'Process Magenta C',  hex: '#D0006F' },
  { code: 'Process Black C',    hex: '#2D2926' },
  { code: 'Black C',            hex: '#2D2926' },
  { code: 'Black 2 C',          hex: '#332F21' },
  { code: 'Black 3 C',          hex: '#212721' },
  { code: 'Black 6 C',          hex: '#101820' },
  { code: 'Black 7 C',          hex: '#3D3935' },

  // Cool Grays
  { code: 'Cool Gray 1 C',  hex: '#D9D9D6' },
  { code: 'Cool Gray 2 C',  hex: '#D0D0CE' },
  { code: 'Cool Gray 3 C',  hex: '#C8C9C7' },
  { code: 'Cool Gray 4 C',  hex: '#BBBCBC' },
  { code: 'Cool Gray 5 C',  hex: '#B1B3B3' },
  { code: 'Cool Gray 6 C',  hex: '#A7A8AA' },
  { code: 'Cool Gray 7 C',  hex: '#97999B' },
  { code: 'Cool Gray 8 C',  hex: '#888B8D' },
  { code: 'Cool Gray 9 C',  hex: '#75787B' },
  { code: 'Cool Gray 10 C', hex: '#63666A' },
  { code: 'Cool Gray 11 C', hex: '#53565A' },

  // Warm Grays
  { code: 'Warm Gray 1 C',  hex: '#D7D2CB' },
  { code: 'Warm Gray 4 C',  hex: '#B6ADA5' },
  { code: 'Warm Gray 7 C',  hex: '#968C83' },
  { code: 'Warm Gray 10 C', hex: '#796E65' },
  { code: 'Warm Gray 11 C', hex: '#6A5F55' },
];

/**
 * Match a Pantone code from common user-typed variants.
 * Accepts: "286", "PMS 286", "286 C", "p286", "Warm Red", "Cool Gray 7", etc.
 * Returns the entry whose code matches loosest first, then by prefix.
 */
export function lookupPantone(input: string): PantoneEntry | null {
  const raw = input.trim();
  if (!raw) return null;

  // Normalise: drop "PMS", "P", leading/trailing whitespace, " C" suffix optionality
  const cleaned = raw
    .replace(/^pms\s+/i, '')
    .replace(/^p(?=\d)/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Exact (case-insensitive) match first
  const exact = PANTONE_COATED.find(
    (e) => e.code.toLowerCase() === cleaned.toLowerCase(),
  );
  if (exact) return exact;

  // Try with " C" appended (user typed numeric code, we store "286" as "286")
  const withC = PANTONE_COATED.find(
    (e) => e.code.toLowerCase() === `${cleaned.toLowerCase()} c`,
  );
  if (withC) return withC;

  // Try stripping a trailing " C" from input (user typed "286 C", we store "286")
  const stripped = cleaned.replace(/\s+c$/i, '');
  const trim = PANTONE_COATED.find(
    (e) => e.code.toLowerCase() === stripped.toLowerCase(),
  );
  if (trim) return trim;

  // Fall back to prefix search on either code or name
  const prefix = PANTONE_COATED.find((e) => {
    const c = e.code.toLowerCase();
    const n = (e.name ?? '').toLowerCase();
    const q = cleaned.toLowerCase();
    return c.startsWith(q) || n.startsWith(q);
  });
  return prefix ?? null;
}
