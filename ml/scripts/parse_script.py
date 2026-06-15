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

    
    avg_words = 0 if len(sentences) == 0 else sum(len(sentence) for sentence in sentences) / len(sentences)

   
    if avg_words<8:
        pacing_label = "fast"
    elif avg_words>15:
        pacing_label = "slow"
    else:
        pacing_label = "medium"
    return {"avg_words_per_sentence": round(avg_words, 1), "label": pacing_label}


def parse_script(script_text):
    """
    Master function that runs all three analyses and returns a single dictionary.
    """
   
    result = {
        "keywords": extract_keywords(script_text),    
        "mood": analyze_mood(script_text),          
        "pacing": estimate_pacing(script_text),
    }

    return result


if __name__ == "__main__":
    horror_text = "The floorboards creak in the heavy silence. A shadow stretches slowly across the bedroom door, freezing Sarah in place. Deep breathing echoes from the darkness."
    action_text = "Suddenly, the glass shatters! Max spins around instantly, draws his weapon, and fires three rapid shots into the smoke. The car roars to life!"

    print("=== Horror Script ===")
    print(parse_script(horror_text))

    print("\n=== Action Script ===")
    print(parse_script(action_text))
