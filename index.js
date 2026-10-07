import {createGenerateNotes} from './lib/generate-notes.js'
import {verifyConditions} from './lib/verify-conditions.js'

const generateNotes = createGenerateNotes()

export {
  generateNotes
, verifyConditions
, createGenerateNotes
}
