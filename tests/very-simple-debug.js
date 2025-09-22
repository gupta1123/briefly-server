#!/usr/bin/env node

/**
 * Very simple debug test
 * Run with: node very-simple-debug.js
 */

// Test the regex patterns directly
const testQuestion = 'What is the title of the contract from Microsoft?';
const q = testQuestion.toLowerCase();

console.log('Question (lowercase):', q);

// Test metadata query pattern
const metadataPattern1 = /\b(what.*about|tell.*about|info.*about|details.*about|metadata.*for|properties.*of|characteristics.*of)\b/i;
const metadataPattern2 = /\b(title|subject|sender|receiver|date|category|type|filename|document.*type|file.*type)\b.*\b(of|for|about)\b/i;
const metadataPattern3 = /\b(list|show|find|search).*\b(documents?|files?)\b/i;

console.log('Pattern 1 match:', metadataPattern1.test(q));
console.log('Pattern 2 match:', metadataPattern2.test(q));
console.log('Pattern 3 match:', metadataPattern3.test(q));

// Test if patterns are matching the actual text
console.log('\nDetailed pattern matching:');
console.log('Pattern 2 regex:', metadataPattern2.toString());
console.log('Does pattern 2 match?', metadataPattern2.test(q));

// Test specific substrings
console.log('\nSubstring tests:');
console.log('Contains "title":', q.includes('title'));
console.log('Contains "of":', q.includes('of'));
console.log('Pattern 2 matches:', q.match(metadataPattern2));