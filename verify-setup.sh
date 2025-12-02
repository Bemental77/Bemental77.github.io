#!/bin/bash

# React Native Project Verification Script

echo "🦙 Chupacabra React Native - Project Verification"
echo "=================================================="
echo ""

PASSED=0
FAILED=0

# Check Node.js
echo -n "Checking Node.js... "
if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v)
    echo "✅ Found: $NODE_VERSION"
    ((PASSED++))
else
    echo "❌ Not found. Visit https://nodejs.org/"
    ((FAILED++))
fi

# Check npm
echo -n "Checking npm... "
if command -v npm &> /dev/null; then
    NPM_VERSION=$(npm -v)
    echo "✅ Found: $NPM_VERSION"
    ((PASSED++))
else
    echo "❌ Not found."
    ((FAILED++))
fi

# Check Java
echo -n "Checking Java (for Android)... "
if command -v java &> /dev/null; then
    JAVA_VERSION=$(java -version 2>&1 | head -1)
    echo "✅ Found"
    ((PASSED++))
else
    echo "⚠️  Not found (Android only). Visit https://www.oracle.com/java/technologies/downloads/"
    ((FAILED++))
fi

# Check Gradle
echo -n "Checking Gradle (for Android)... "
if [ -f "android/gradle/wrapper/gradle-wrapper.jar" ]; then
    echo "✅ Found"
    ((PASSED++))
else
    echo "⚠️  Not found (Android only)"
    ((FAILED++))
fi

# Check Xcode (macOS only)
if [[ "$OSTYPE" == "darwin"* ]]; then
    echo -n "Checking Xcode (for iOS)... "
    if command -v xcode-select &> /dev/null; then
        echo "✅ Found"
        ((PASSED++))
    else
        echo "❌ Not found. Run: xcode-select --install"
        ((FAILED++))
    fi
fi

# Check project files
echo -n "Checking project files... "
if [ -f "package.json" ] && [ -d "src" ] && [ -d "android" ] && [ -d "ios" ]; then
    echo "✅ Found"
    ((PASSED++))
else
    echo "❌ Missing project files"
    ((FAILED++))
fi

# Check dependencies
echo -n "Checking node_modules... "
if [ -d "node_modules" ]; then
    echo "✅ Found"
    ((PASSED++))
else
    echo "⚠️  Not found. Run: npm install"
    ((FAILED++))
fi

# Check iOS pods (macOS only)
if [[ "$OSTYPE" == "darwin"* ]]; then
    echo -n "Checking iOS pods... "
    if [ -d "ios/Pods" ]; then
        echo "✅ Found"
        ((PASSED++))
    else
        echo "⚠️  Not found. Run: npm run pods"
        ((FAILED++))
    fi
fi

echo ""
echo "=================================================="
echo "Results: $PASSED passed, $FAILED warnings/failures"
echo ""

if [ $FAILED -gt 0 ]; then
    echo "📚 Next steps:"
    echo "1. Install missing dependencies from warnings above"
    echo "2. Run: npm install"
    if [[ "$OSTYPE" == "darwin"* ]]; then
        echo "3. Run: npm run pods"
    fi
    echo ""
fi

echo "🚀 Ready to start development:"
echo ""
echo "  npm start       # Start Metro bundler"
echo "  npm run android # Run on Android"
if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "  npm run ios     # Run on iOS"
fi
echo ""
echo "✨ Happy coding!"
