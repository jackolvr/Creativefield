/* Swap a thing: one panel, the app routes (DOC-2191). The person only says what should change; this decides how,
   from the sentence, the references and the source. Words first, like the intent router beside it: fast, offline and
   testable. It names no workflow: a route becomes a workflow through the manifests' role, in the panel.

   Routes:
   - "picture": the source is a picture, so it is a picture edit.
   - "person":  a person is swapped for one in a reference ("replace him with this person").
   - "thing":   one named thing changes and only its area is rendered ("the bike yellow", "remove this bottle",
                "make this character look like a cartoon": an element of the clip, not the whole clip).
   - "look":    the whole clip changes: light, time of day, weather, style, colours of everything.
   Where a route needs a picture the person did not give, `picture` says where it comes from: never generated over
   one of their own; an edited frame of their clip before a picture from words; otherwise ask. */

export type SwapRoute = "picture" | "person" | "thing" | "look";
export type SwapReference = {kind?: "person" | "other"};
export type SwapInput = {source?: "video" | "image"; references: readonly SwapReference[]; text: string};
/** What this computer can do for a missing picture: edit a frame of the clip, or make a picture from words. */
export type PictureAbility = {editFrame: boolean; fromWords: boolean};
export type PictureSource = "own" | "frame" | "words" | "ask";
export type SwapDecision =
  | {ready: false; needs: "source" | "text"; say: string}
  | {ready: true; route: SwapRoute; target?: string; picture: PictureSource; say: string};

/* Words that mean the whole clip rather than a thing in it (English and German). */
const LOOK = /\b(lighting|light|lights|illumination|night|nighttime|daytime|day time|sunset|sunrise|golden hour|dusk|dawn|weather|rain|rainy|snow|snowy|fog|foggy|style|look|mood|atmosphere|colou?rs?|colou?r grad(?:e|ing)|tone|cartoon|anime|painting|painted|watercolou?r|oil painting|comic|sketch|claymation|pixar|cinematic|vintage|retro|black and white|sepia|whole (?:video|clip|scene|thing)|everything|licht|beleuchtung|nacht|abend|tag|sonnenuntergang|wetter|regen|schnee|nebel|stil|stimmung|farben|farbe|farbstimmung|zeichentrick|gemälde|aquarell|comicstil|ganze[sn]? (?:video|clip|bild|szene)|alles)\b/i;
/* The whole-clip nouns: "change the lighting" names the light, not a thing. */
const GLOBAL_NOUN = /^(lighting|light|lights|sunlight|colou?rs?|mood|atmosphere|style|look|weather|rain|snow|fog|night|evening|morning|daytime|sunset|sunrise|tone|scene|video|clip|picture|image|whole (?:video|clip|scene)|licht|beleuchtung|sonnenlicht|farben?|stimmung|stil|wetter|regen|schnee|nebel|nacht|abend|morgen|sonnenuntergang|szene|video|clip|bild)$/i;
const PERSON = /\b(him|her|he|she|they|them|man|woman|person|people|guy|girl|boy|kid|child|character|actor|actress|rider|driver|dancer|face|ihn|sie|er|mann|frau|person|typ|mädchen|junge|kind|figur|charakter|fahrer|tänzer|gesicht)\b/i;
/* "replace him with this person", "put the person from the picture in", "as this character". */
const REPLACE_PERSON = /\b(replace|swap|exchange|recast|turn|ersetz\w*|tausch\w*)\b.*\b(with|by|for|into|durch|gegen|mit)\b.*\b(this|that|the|my|dies\w*|der|die|das|meine?\w*)\b.*\b(person|character|man|woman|guy|girl|actor|face|picture|photo|reference|figur|charakter|mann|frau|bild|foto|referenz)\b/i;
const ARTICLE = "(?:the|this|that|these|those|his|her|their|my|der|die|das|den|dem|diese[nrsm]?|dieses|seine[nrsm]?|ihre[nrsm]?|meine[nrsm]?)";
/* Colours and other describing words end the thing: "the bike yellow" names the bike. */
const DESCRIBING = /^(yellow|red|blue|green|black|white|pink|purple|orange|gold|golden|silver|grey|gray|brown|bigger|smaller|darker|brighter|gelb|rot|blau|grün|schwarz|weiß|weiss|rosa|lila|silbern|grau|braun|größer|kleiner|dunkler|heller)$/i;
const STOP = /^(of|with|from|to|into|in|on|at|by|and|or|but|so|that|which|who|be|is|are|should|must|will|would|look|looks|like|soll|sollte|muss|wird|wie|aus|mit|von|zu|in|im|und|oder|ist|sind|sein|werden|aussehen|aussieht|machen|weg|entfernen)$/i;

/** The thing the sentence names: "the glass bottle", "this character", "das Fahrrad". Undefined when none. */
export function swapTarget(text: string): string | undefined {
  const words = text.replace(/[.,!?;:"“”„]/g, " ").split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i += 1) {
    if (!new RegExp(`^${ARTICLE}$`, "i").test(words[i])) continue;
    const noun: string[] = [];
    for (let k = i + 1; k < words.length && noun.length < 3; k += 1) {
      // A describing word ends the thing only after it ("the bike yellow"), not before it ("the red car").
      if (STOP.test(words[k]) || (noun.length && DESCRIBING.test(words[k])) || new RegExp(`^${ARTICLE}$`, "i").test(words[k])) break;
      noun.push(words[k]);
    }
    if (noun.length) return `${words[i].toLowerCase()} ${noun.join(" ")}`;
  }
  // A pronoun names the person on screen.
  return /\b(him|her|ihn)\b/i.test(text) ? "the person" : undefined;
}

const nounOf = (target: string) => target.split(/\s+/).slice(1).join(" ") || target;

/** Where a missing picture comes from: their own first, then an edited frame of the clip, then words, else ask. */
export function pictureSource(references: readonly SwapReference[], can: PictureAbility): PictureSource {
  if (references.length) return "own";
  if (can.editFrame) return "frame";
  if (can.fromWords) return "words";
  return "ask";
}

const PICTURE_WORDS: Record<PictureSource, string> = {
  own: "",
  frame: " It uses an edited frame of your clip as the picture.",
  words: " It makes a picture of it first.",
  ask: " Add a picture of what it should become.",
};

/** How a swap runs, in plain words for the line under the button. */
export function routeSwap(input: SwapInput, can: PictureAbility): SwapDecision {
  const text = input.text.trim();
  if (!input.source) return {ready: false, needs: "source", say: "Add the clip or picture to change."};
  if (!text) return {ready: false, needs: "text", say: "Say what should change, for example “make the bike yellow”."};
  const picture = pictureSource(input.references, can);
  const target = swapTarget(text);
  const say = (line: string, source: PictureSource) => `${line}${PICTURE_WORDS[source]}`;
  if (input.source === "image") return {ready: true, route: "picture", target, picture: "own", say: "Edits the picture as you describe."};
  const personReference = input.references.some(ref => ref.kind === "person") || (input.references.length > 0 && REPLACE_PERSON.test(text));
  if (personReference && (REPLACE_PERSON.test(text) || (target !== undefined && PERSON.test(target)))) {
    // The one replaced is named before "with" / "durch"; the new one is the picture.
    const replaced = swapTarget(text.split(/\b(?:with|by|for|durch|gegen|mit)\b/i)[0]) ?? "the person";
    return {ready: true, route: "person", target: replaced, picture: "own", say: `Replaces ${replaced} with the person in your picture; the rest of the clip stays.`};
  }
  if (target && !GLOBAL_NOUN.test(nounOf(target))) {
    return {ready: true, route: "thing", target, picture, say: say(`Changes ${target}; the rest of the clip stays as it is.`, picture)};
  }
  if (LOOK.test(text) || (target && GLOBAL_NOUN.test(nounOf(target)))) {
    return {ready: true, route: "look", target, picture, say: say("Changes the look of the whole clip.", picture)};
  }
  // Unclear: a thing it cannot name. The area swap is the safe default; the line asks for the one missing word.
  return {ready: true, route: "thing", target, picture, say: say("Changes the thing you describe; name it (“the bike”) to be sure.", picture)};
}
