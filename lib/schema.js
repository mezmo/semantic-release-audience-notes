import {CONFIDENCE_LEVELS, IMPORTANCE_LEVELS, OMISSION_REASONS} from './constants.js'

// Input schema for the terminal submit_release_notes tool. Structured outputs
// reject length and numeric constraints, so this fixes shape and vocabulary
// only; prose rules are enforced by lib/entries.js afterward.
//
// An entry claims one or more commits, so several commits that together deliver
// one change collapse to one line. Every commit an entry does not claim must
// appear in `omitted`, which keeps a deliberate drop distinguishable from an
// oversight.
//
// There is deliberately no `summary` parameter. A paragraph-length leading string
// flips the model out of JSON tool calls into its legacy XML syntax, which takes
// the rest of the call with it -- the entries array arrives concatenated into the
// summary's value rather than as a key of its own. Keep every parameter here
// short. See anthropics/claude-code#49747.
function build(options) {
  const oneLine = options.entryStyle === 'conventional'
  return {
    type: 'object'
  , properties: {
      entries: {
        type: 'array'
      , description:
          'One per distinct change, not one per commit. Commits that together deliver '
            + 'a single change share one entry.'
      , items: {
          type: 'object'
        , properties: {
            hashes: {
              type: 'array'
            , description:
                'Short hashes of every commit this entry covers, copied verbatim. '
                  + 'Usually one; more when several commits deliver one change.'
            , items: {type: 'string'}
            }
          , supporting: {
              type: 'array'
            , description:
                'Short hashes of commits that helped deliver this change but were '
                  + 'never a state the reader ran: a fix to something this same '
                  + 'release introduces, its tests, a refactor made while building '
                  + 'it. They are covered by this entry and get no line of their '
                  + 'own. Empty array when there are none.'
            , items: {type: 'string'}
            }
          , section: {
              'type': 'string'
            , 'enum': options.sectionIds
            , 'description': 'The section this change belongs in.'
            }
          , scope: {
              type: 'string'
            , description:
                'Lowercase component or module name this change touches, such as '
                  + '"api-auth" or "ingest-pipeline". Empty string when unclear.'
            }
          , headline: {
              type: 'string'
            , description: oneLine
                ? 'The whole entry for this change: one sentence naming what it is '
                  + 'and anything the reader needs to know about it.'
                : 'The lead line for this change: one short sentence or noun phrase '
                  + 'naming what it is. Detail belongs in `details`, not here.'
            }
          , details: {
              type: 'array'
            , description: oneLine
                ? 'Always an empty array. This layout renders only the headline.'
                : `Up to ${options.limits.maxDetails} further sentences: how to use `
                  + 'it, why it works that way, what the reader must do, what the old '
                  + 'behavior was. Each item is one complete sentence. Use an empty '
                  + 'array when the headline says everything.'
            , items: {type: 'string'}
            }
          , importance: {
              'type': 'string'
            , 'enum': IMPORTANCE_LEVELS
            , 'description':
                'How much this matters to the stated audience, not how much work it '
                  + 'was. "critical" forces action or risks breakage; "high" changes '
                  + 'what they can do or must know; "medium" is a real improvement '
                  + 'they would notice; "low" is worth listing but easy to skip.'
            }
          , confidence: {
              'type': 'string'
            , 'enum': CONFIDENCE_LEVELS
            , 'description':
                'How well the evidence you read supports this description. '
                  + 'Use "low" when the commit message and diff were thin.'
            }
          }
        , required: [
            'hashes', 'supporting', 'section', 'scope', 'headline', 'details'
          , 'importance', 'confidence'
          ]
        , additionalProperties: false
        }
      }
    , omitted: {
        type: 'array'
      , description:
          'Commits deliberately left out because they do not matter to this audience. '
            + 'Every commit no entry claims belongs here.'
      , items: {
          type: 'object'
        , properties: {
            hash: {type: 'string', description: 'Short hash, copied verbatim.'}
          , reason: {
              'type': 'string'
            , 'enum': OMISSION_REASONS
            , 'description': 'Why this commit earns no line for this audience.'
            }
          }
        , required: ['hash', 'reason']
        , additionalProperties: false
        }
      }
    }
  , required: ['entries', 'omitted']
  , additionalProperties: false
  }
}

export {build}
