# Use official Python 3.12 image
FROM python:3.12-slim

# Set work directory
WORKDIR /app

# Copy requirements and install dependencies
COPY requirements/base.txt ./requirements/base.txt
RUN pip install --upgrade pip \
	&& pip install -r requirements/base.txt

# Copy the rest of the code
COPY . .

# Set environment variables (optional, add as needed)
# ENV PYTHONUNBUFFERED=1

# Default command to run your backend
CMD ["python", "run.py"]
