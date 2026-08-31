import os
import sys

# Add the root directory to the path so handler can find app.py
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "../../")))

from app import app
from mangum import Mangum

# Wrap the Flask app with Mangum for serverless execution
handler = Mangum(app)
