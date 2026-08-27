import type { Generation } from "./generations.ts";

/**
 * カメラ世代の国別存在データ。
 * @see https://geohints.com/meta/cameraGens
 *
 * - 国コード: `pano-meta.ts`の`getPanoMeta().countryCode`と同じISO 3166-1 alpha-2("Kosovo"のみGoogleに合わせて"XK")。
 * - "Trekker", "Low Cam"は対象外。
 * - 一部の国では、隣国に広域に存在するカメラが国境付近にわずかに存在する影響で、国境に存在しないカメラが記載されていることがあるが、そのようなケースは無視する
 */
export const CAMERA_GENS_BY_COUNTRY: ReadonlyMap<
  string,
  readonly Generation[]
> = new Map([
  ["AD", ["Gen2", "Gen3"]], // Andorra
  ["AE", ["Gen3", "Gen4"]], // United Arab Emirates
  ["AF", []], // Afghanistan
  ["AL", ["Gen3", "Smallcam"]], // Albania
  ["AR", ["Gen3", "Gen4", "Smallcam"]], // Argentina
  ["AS", ["Gen3"]], // American Samoa
  ["AT", ["Shitcam", "Gen2", "Gen3", "Gen4", "Smallcam"]], // Austria
  ["AU", ["Gen1", "Gen2", "Gen3", "Gen4"]], // Australia
  ["AX", ["Gen2", "Gen3"]], // Åland
  ["BA", ["Gen4", "Smallcam"]], // Bosnia and Herzegovina
  ["BD", ["Shitcam", "Gen3", "Gen4"]], // Bangladesh
  ["BE", ["Gen2", "Gen3", "Gen4", "Smallcam"]], // Belgium
  ["BG", ["Shitcam", "Gen3", "Gen4"]], // Bulgaria
  ["BM", ["Gen3"]], // Bermuda
  ["BO", ["Gen3", "Gen4"]], // Bolivia
  ["BR", ["Gen2", "Gen3", "Gen4", "Smallcam"]], // Brazil
  ["BT", ["Gen3"]], // Bhutan
  ["BW", ["Gen3"]], // Botswana
  ["BY", []], // Belarus
  ["BZ", []], // Belize
  ["CA", ["Gen1", "Gen2", "Gen3", "Gen4", "Smallcam"]], // Canada
  ["CC", ["Gen3"]], // Cocos (Keeling) Islands
  ["CH", ["Gen2", "Gen3", "Gen4"]], // Switzerland
  ["CL", ["Gen3", "Gen4"]], // Chile
  ["CN", []], // China
  ["CO", ["Gen3", "Gen4"]], // Colombia
  ["CR", ["Gen4"]], // Costa Rica
  ["CW", ["Gen3"]], // Curaçao
  ["CX", ["Gen3"]], // Christmas Island
  ["CY", ["Shitcam", "Smallcam"]], // Cyprus
  ["CZ", ["Shitcam", "Gen2", "Gen3", "Gen4"]], // Czech Republic
  ["DE", ["Shitcam", "Gen2", "Gen3", "Gen4", "Smallcam"]], // Germany
  ["DK", ["Shitcam", "Gen2", "Gen3", "Gen4", "Smallcam"]], // Denmark
  ["DO", ["Gen3"]], // Dominican Republic
  ["EC", ["Shitcam", "Gen3", "Gen4"]], // Ecuador
  ["EE", ["Shitcam", "Gen3", "Gen4"]], // Estonia
  ["EG", []], // Egypt
  ["ES", ["Shitcam", "Gen2", "Gen3", "Gen4", "Smallcam"]], // Spain
  ["FI", ["Shitcam", "Gen2", "Gen3", "Gen4", "Smallcam"]], // Finland
  ["FK", []], // Falkland Islands
  ["FO", ["Gen3", "Gen4"]], // Faroe Islands
  ["FR", ["Shitcam", "Gen1", "Gen2", "Gen3", "Gen4", "Smallcam"]], // France
  ["GB", ["Shitcam", "Gen2", "Gen3", "Gen4", "Smallcam"]], // United Kingdom
  ["GE", ["Gen4", "Smallcam"]], // Georgia
  ["GH", ["Gen3", "Gen4", "Smallcam"]], // Ghana
  ["GI", ["Gen3"]], // Gibraltar
  ["GL", ["Gen3"]], // Greenland
  ["GM", []], // Gambia
  ["GR", ["Shitcam", "Gen2", "Gen3", "Gen4", "Smallcam"]], // Greece
  ["GS", []], // South Georgia and the South Sandwich Islands
  ["GT", ["Gen3"]], // Guatemala
  ["GU", ["Gen3"]], // Guam
  ["GY", []], // Guyana
  ["HK", ["Gen2", "Gen3", "Gen4"]], // Hong Kong
  ["HR", ["Shitcam", "Gen3", "Gen4"]], // Croatia
  ["HU", ["Gen2", "Gen3", "Gen4"]], // Hungary
  ["ID", ["Gen3", "Gen4"]], // Indonesia
  ["IE", ["Shitcam", "Gen2", "Gen3", "Gen4", "Smallcam"]], // Ireland
  ["IL", ["Gen2", "Gen3", "Gen4"]], // Israel
  ["IM", ["Gen2"]], // Isle of Man
  ["IN", ["Shitcam", "Gen3", "Smallcam"]], // India
  ["IO", []], // British Indian Ocean Territory
  ["IQ", []], // Iraq
  ["IS", ["Gen3", "Gen4"]], // Iceland
  ["IT", ["Shitcam", "Gen1", "Gen2", "Gen3", "Gen4", "Smallcam"]], // Italy
  ["JE", ["Gen2"]], // Jersey
  ["JO", ["Gen3"]], // Jordan
  ["JP", ["Gen1", "Gen2", "Gen3", "Gen4"]], // Japan
  ["KE", ["Gen3", "Gen4"]], // Kenya
  ["KG", ["Gen3"]], // Kyrgyzstan
  ["KH", ["Shitcam", "Gen3"]], // Cambodia
  ["KR", ["Gen2", "Gen3"]], // South Korea
  ["KZ", ["Gen3", "Gen4"]], // Kazakhstan
  ["LA", ["Gen3"]], // Laos
  ["LB", ["Shitcam"]], // Lebanon
  ["LI", ["Shitcam", "Gen4"]], // Liechtenstein
  ["LK", ["Shitcam", "Gen3", "Gen4"]], // Sri Lanka
  ["LS", ["Gen3"]], // Lesotho
  ["LT", ["Shitcam", "Gen3", "Gen4"]], // Lithuania
  ["LU", ["Gen2", "Gen3", "Gen4", "Smallcam"]], // Luxembourg
  ["LV", ["Shitcam", "Gen3", "Gen4"]], // Latvia
  ["MC", ["Gen1", "Gen2", "Gen3", "Gen4", "Smallcam"]], // Monaco
  ["ME", ["Gen3", "Smallcam"]], // Montenegro
  ["MG", ["Gen3"]], // Madagascar
  ["MK", ["Gen3", "Smallcam"]], // North Macedonia
  ["ML", []], // Mali
  ["MM", []], // Myanmar
  ["MN", ["Gen3", "Gen4"]], // Mongolia
  ["MO", ["Gen2"]], // Macao
  ["MP", ["Gen3"]], // Northern Mariana Islands
  ["MT", ["Gen3", "Gen4"]], // Malta
  ["MX", ["Gen1", "Gen2", "Gen3", "Gen4"]], // Mexico
  ["MY", ["Gen3", "Gen4"]], // Malaysia
  ["NA", ["Gen4"]], // Namibia
  ["NG", ["Shitcam", "Gen3", "Gen4"]], // Nigeria
  ["NI", []], // Nicaragua
  ["NL", ["Gen2", "Gen3", "Gen4", "Smallcam"]], // Netherlands
  ["NO", ["Shitcam", "Gen2", "Gen3", "Gen4", "Smallcam"]], // Norway
  ["NP", ["Shitcam"]], // Nepal
  ["NZ", ["Gen1", "Gen2", "Gen3", "Gen4"]], // New Zealand
  ["OM", ["Gen4"]], // Oman
  ["PA", ["Gen4"]], // Panama
  ["PE", ["Gen3", "Gen4", "Smallcam"]], // Peru
  ["PH", ["Gen3", "Gen4"]], // Philippines
  ["PK", ["Gen3"]], // Pakistan
  ["PL", ["Shitcam", "Gen2", "Gen3", "Gen4", "Smallcam"]], // Poland
  ["PN", []], // Pitcairn Islands
  ["PR", ["Gen3", "Smallcam"]], // Puerto Rico
  ["PS", ["Gen3", "Gen4"]], // Palestine
  ["PT", ["Shitcam", "Gen2", "Gen3", "Gen4", "Smallcam"]], // Portugal
  ["PY", ["Gen3", "Gen4", "Smallcam"]], // Paraguay
  ["QA", ["Gen4"]], // Qatar
  ["RO", ["Shitcam", "Gen2", "Gen3", "Gen4"]], // Romania
  ["RS", ["Gen3", "Gen4", "Smallcam"]], // Serbia
  ["RU", ["Gen2", "Gen3", "Gen4"]], // Russia
  ["RW", ["Gen4"]], // Rwanda
  ["SE", ["Shitcam", "Gen2", "Gen3", "Gen4", "Smallcam"]], // Sweden
  ["SG", ["Gen2", "Gen3", "Gen4"]], // Singapore
  ["SI", ["Shitcam", "Gen2", "Gen3", "Gen4", "Smallcam"]], // Slovenia
  ["SK", ["Shitcam", "Gen3", "Gen4", "Smallcam"]], // Slovakia
  ["SM", ["Gen2", "Gen3", "Gen4"]], // San Marino
  ["SN", ["Gen3", "Gen4"]], // Senegal
  ["ST", ["Shitcam"]], // São Tomé and Príncipe
  ["SY", []], // Syria
  ["SZ", ["Gen3"]], // Eswatini
  ["TH", ["Gen3", "Gen4"]], // Thailand
  ["TN", ["Gen3"]], // Tunisia
  ["TR", ["Gen3", "Gen4", "Smallcam"]], // Turkey
  ["TW", ["Gen2", "Gen3", "Gen4"]], // Taiwan
  ["TZ", []], // Tanzania
  ["UA", ["Gen3"]], // Ukraine
  ["UG", ["Gen3"]], // Uganda
  ["UM", []], // United States Minor Outlying Islands
  ["US", ["Shitcam", "Gen1", "Gen2", "Gen3", "Gen4", "Smallcam"]], // United States
  ["UY", ["Gen3", "Gen4", "Smallcam"]], // Uruguay
  ["VE", []], // Venezuela
  ["VI", ["Gen3"]], // United States Virgin Islands
  ["VN", ["Shitcam", "Gen3", "Gen4"]], // Vietnam
  ["VU", []], // Vanuatu
  ["XK", ["Gen4", "Smallcam"]], // Kosovo
  ["ZA", ["Gen2", "Gen3", "Gen4", "Smallcam"]], // South Africa
]);
