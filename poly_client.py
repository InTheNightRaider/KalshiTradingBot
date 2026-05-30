import os
from dotenv import load_dotenv
from py_clob_client.client import ClobClient

# Load .env file from same directory as this script
load_dotenv(os.path.join(os.path.dirname(__file__), '.env'))

HOST     = "https://clob.polymarket.com"
CHAIN_ID = int(os.getenv("POLY_CHAIN_ID", 137))
PRIV_KEY = os.getenv("POLY_PRIVATE_KEY")

def get_client():
    if not PRIV_KEY:
        raise ValueError("POLY_PRIVATE_KEY not set in .env file")
    client = ClobClient(HOST, key=PRIV_KEY, chain_id=CHAIN_ID)
    creds = client.create_or_derive_api_creds()
    client.set_api_creds(creds)
    return client

if __name__ == "__main__":
    print("Connecting to Polymarket...")
    try:
        client = get_client()
        print("Connected! Wallet address:", client.get_address())
        bal = client.get_balance()
        print("USDC Balance: $" + str(bal))
    except Exception as e:
        print("Error:", e)
