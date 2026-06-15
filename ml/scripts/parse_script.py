# pyrefly: ignore [missing-import]
import spacy
# pyrefly: ignore [missing-import]
from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

# --- NLP Setup (Hard part - provided) ---
nlp = spacy.load("en_core_web_sm")
vader = SentimentIntensityAnalyzer()


def extract_keywords(script_text):
    """
    Uses spaCy to extract meaningful noun chunks from the script.
    Example: "A dark figure in an abandoned hospital" -> ["dark figure", "abandoned hospital"]
    """
    doc = nlp(script_text)

    # spaCy's noun_chunks gives us multi-word phrases like "dark figure"
    # We filter out chunks that are just pronouns or determiners (like "it", "the", "a")
    keywords = []
    for chunk in doc.noun_chunks:
        # chunk.root.pos_ gives the part-of-speech of the main word in the chunk
        if chunk.root.pos_ not in ("PRON", "DET"):
            keywords.append(chunk.text.lower())

    return keywords


def analyze_mood(script_text):
    """
    Uses VADER to determine the emotional mood of the script.
    Returns a dict with: compound score (-1 to 1), and a human-readable mood label.
    """
    scores = vader.polarity_scores(script_text)
    compound = scores["compound"]

   
    if compound <=-0.3:
        mood_label = "dark"
    elif compound >=0.3:
        mood_label = "uplifting"
    else:
        mood_label = "neutral"

    return {"compound": compound, "label": mood_label}


def estimate_pacing(script_text):
    """
    Estimates pacing based on average sentence length.
    Short sentences = fast pacing (action/horror).
    Long sentences = slow pacing (documentary/drama).
    """
    doc = nlp(script_text)
    sentences = list(doc.sents)

    # TODO 2: Calculate the average number of words per sentence.
    # Hints:
    #   - len(sentences) gives you the number of sentences
    #   - len(sentence) gives you the number of tokens in a sentence
    #   - Watch out for division by zero if there are no sentences!
    avg_words = 0 if len(sentences) == 0 else sum(len(sentence) for sentence in sentences) / len(sentences)

    # TODO 3: Assign a pacing_label based on avg_words.
    # Rules:
    #   - If avg_words < 8, pacing_label = "fast"
    #   - If avg_words > 15, pacing_label = "slow"
    #   - Otherwise, pacing_label = "medium"
    pacing_label = ""  # <-- Replace this

    return {"avg_words_per_sentence": round(avg_words, 1), "label": pacing_label}


def parse_script(script_text):
    """
    Master function that runs all three analyses and returns a single dictionary.
    """
    # TODO 4: Call the three functions above and build the output dictionary.
    # The returned dict should look like:
    # {
    #     "keywords": [...],       <-- from extract_keywords()
    #     "mood": {...},           <-- from analyze_mood()
    #     "pacing": {...},         <-- from estimate_pacing()
    # }
    result = {}  # <-- Replace this

    return result


# --- Main Block ---
if __name__ == "__main__":
    # TODO 5: Create a test_script string with 2-3 sentences of sample script text.
    # Then call parse_script() on it and print the result nicely.
    # Hint: Use a horror or action script to see interesting mood/pacing results.
    pass
