exports.handler = async function (event) {
  try {
    const date = event.queryStringParameters?.date;

    if (!date) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Date is required" })
      };
    }

    const response = await fetch(
      `https://api-web.nhle.com/v1/score/${date}`
    );

    if (!response.ok) {
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: "NHL API request failed" })
      };
    }

    const data = await response.json();

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(data)
    };

  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Something went wrong"
      })
    };
  }
};
