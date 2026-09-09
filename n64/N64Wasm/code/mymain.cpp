#include <iostream>

//using STB library to load the PNG files
#define STB_IMAGE_IMPLEMENTATION
#include "stb_image.h"

#ifdef __EMSCRIPTEN__
#include <SDL2/SDL.h>
#include <SDL2/SDL_ttf.h>
#include <SDL2/SDL_image.h>
#include <emscripten.h>
#include <SDL/SDL_opengl.h>
#else
#define GLEW_STATIC
#include <GL/glew.h>
#include <SDL.h>
#include <SDL_ttf.h>
#include <SDL_image.h>
#include <SDL_opengl.h>
#endif

#include <fstream>
#include <string>
#include <sstream>

extern "C" {
#include "neil.h"

int angryVerticalResolution = 240;
int mouseX = 0;
int mouseY = 0;
int mousePressed = 0;
int mouseRange = 40;
int g_jit_bridge = 0; /* JIT bridge toggle, read by r4300/recomp.c; set via neil_set_jit_bridge */

/* per-frame emulation cost meter (n64/docs/jit M2 perf): wall time spent
 * inside retro_run, accumulated so the page can compute avg cost per VI
 * frame — the direct CPU-throughput metric, immune to the frame limiter */
double g_frame_cost_ms = 0.0;
unsigned int g_frame_cost_n = 0;

}

#include "neil_controller.h"

extern "C" {
    struct NeilCheats neilCheats[256];
    int neilCheatsLength = 0;
    bool doubleSpeed = false;
}
 
#ifdef _WIN32
#define USE_XINPUT //COMMENT OUT TO FALL BACK TO SDL JOYSTICK CODE (UNRELIABLE)
#endif

#ifdef USE_XINPUT
#include <Windows.h>
#include <Xinput.h>
#pragma comment(lib,"XInput.lib")

struct XInputController
{
	XINPUT_STATE state;
	int xGamepadIndex = -1;
	bool connected = false;
};

struct XInputController xControllers[4];

#endif

#ifdef USE_XINPUT
bool IsPressed(WORD button, int index)
{
    return (xControllers[index].state.Gamepad.wButtons & button) != 0;
}
#endif

struct SdlJoystick
{
	SDL_Joystick* joyStick = NULL;
	SDL_GameController* gameController = NULL;
	bool gamepadConnected = false;
};

struct SdlJoystick sdlJoysticks[4];
int joystickCount = 0;
int previousControllerCount = 0;

int axis0 = 0;
int axis1 = 0;
int axis2 = 0;
int axis3 = 0;
int axis4 = 0;
int axis5 = 0;
Uint8* keyboardState;
extern "C" {
    struct NeilButtons neilbuttons[4];
    bool forceAngry = true;
}

// ===========================================================================
// LOCKSTEP — DETERMINISTIC ONLINE PLAY (2026-09-08)
//
// Online play on this console used to mean ONE emulator: the host ran the game,
// streamed its canvas over WebRTC, and the guest's buttons were merged into the
// HOST's controller (n64/index.html's PATH A) or into a synthetic gamepad SDL
// happened to enumerate (PATH B). Player 2 was watching a video of somebody
// else's N64, and every button they pressed cost a network round trip plus an
// encode plus a decode. That architecture is CANCELLED. Under lockstep every
// machine runs its own core, only pad bytes cross the wire, and each player's
// own input is applied locally — which is what a console does.
//
// WHY THIS NEEDED CORE CHANGES AT ALL, stated plainly, because the JS side
// could not have done it:
//   1. neil_send_mobile_controls (below) writes neilbuttons[0] in every one of
//      its 21 assignments. There was NO way to address ports 2-4 from JS, so
//      "four players" was not merely unwired, it was unreachable.
//   2. It is only CALLED when `mobileMode && !sdlJoysticks[0].gamepadConnected`
//      (mainLoopInner), so on desktop there was no JS -> core input path at all.
//   3. mainLoopInner's frame is gated on TWO wall-clock conditions — IsFrameReady()
//      (SDL_GetTicks budget) and the SDL audio-queue depth — so how far the guest
//      advanced depended on how fast the host machine happened to be. Input keyed
//      to wall time lands on a DIFFERENT emulated frame on each machine, which is
//      a desync by construction.
// The three entry points below fix exactly those three things and nothing else.
//
// ⚠ THE GUEST RATE IS NOT A KNOB HERE (CLAUDE.md gate #9). neil_ls_run_frame()
// runs exactly ONE mainLoopInner per call and the page calls it once per agreed
// frame. It cannot make the guest run faster than the room's slowest peer; the
// only thing it can do is stall. There is no catch-up sprint, and adding one
// would be the manufactured-speed failure gate #9 forbids.
//
// ⚠ AND IT NEVER GUESSES. A missing input stalls the PAGE's driver; nothing
// here substitutes a plausible pad, because a guessed pad forks the two
// simulations silently and permanently.
struct NeilButtons g_ls_pads[NEILNUMCONTROLLERS];
// 0 = the shipped free-running behaviour, byte for byte. Every single-player
// session and every offline boot runs with this at 0 and reaches none of the
// code below.
int g_ls_on = 0;
// Set only for the duration of one neil_ls_run_frame() call, to lift the two
// wall-clock frame gates for that one frame. Outside a lockstep frame both
// gates behave exactly as they always did.
int g_ls_forcing = 0;
bool loadEep = false;
bool loadSra = false;
bool loadFla = false;
bool showFPS = true;
bool swapSticks = false;
bool mouseMode = false;
bool disableAudioSync = false;
bool invert2P = false;
bool invert3P = false;
bool invert4P = false;
bool mobileMode = false;
bool endframeCallback = false;

extern "C" {
    int triangleCount = 0;
    int globalTriangleTrigger = 0;
    bool pilotwingsFix = false;
    bool vbuf_use_vbo = false;
}

void connectGamepad()
{
#ifdef USE_XINPUT
    DWORD dwResult;
    previousControllerCount = joystickCount;
	joystickCount = 0;
	xControllers[0].connected = false;
	xControllers[1].connected = false;
	xControllers[2].connected = false;
	xControllers[3].connected = false;

    for (DWORD i = 0; i < XUSER_MAX_COUNT; i++)
	{
		if (joystickCount < 4)
		{
			ZeroMemory(&xControllers[joystickCount].state, sizeof(XINPUT_STATE));

			// Simply get the state of the controller from XInput.
			dwResult = XInputGetState(i, &xControllers[joystickCount].state);

			if (dwResult == ERROR_SUCCESS)
			{
				xControllers[joystickCount].connected = true;
				xControllers[joystickCount].xGamepadIndex = i;

				joystickCount++;
			}
		}
	}

	if (previousControllerCount != joystickCount)
	{
		printf("Controllers Connected: %d\n", joystickCount);
	}

    return;
#endif
    
    if (SDL_NumJoysticks() != previousControllerCount)
	{
		joystickCount = 0;
		sdlJoysticks[0].gamepadConnected = false;
		sdlJoysticks[1].gamepadConnected = false;
		sdlJoysticks[2].gamepadConnected = false;
		sdlJoysticks[3].gamepadConnected = false;
		for(int i = 0; i < SDL_NumJoysticks(); i++)
		{
			//Load joystick
			SDL_Joystick* tempJoyStick = SDL_JoystickOpen(i);
			const char* name = SDL_JoystickName(tempJoyStick);

			//skip logitech device
			int compare = 0;
			compare = strcmp(name,"Logitech H820e (Vendor: 046d Product: 0a4a)");
			if (compare == 0)
			{
				printf("skipping logitech device\n");
			}
			else
			{
				if (tempJoyStick != NULL)
				{
					sdlJoysticks[joystickCount].joyStick = tempJoyStick;
					printf("Connected Joystick %s\n", name);
					if (SDL_IsGameController(i))
					{
						sdlJoysticks[joystickCount].gameController = SDL_GameControllerOpen(i);
						printf("Connected Connected %s\n", SDL_GameControllerName(sdlJoysticks[joystickCount].gameController));
					}
					sdlJoysticks[joystickCount].gamepadConnected = true;
					joystickCount++;
				}
				
			}

		}
	}

	previousControllerCount = SDL_NumJoysticks();

}

enum MY_FONT_SIZE { 
    FONTSIZE_24, 
    FONTSIZE_40
};

TTF_Font* font24;
TTF_Font* font40;
SDL_Color fontcolorWhite = { 255, 255, 255 };
SDL_Color fontcolorRed = { 0, 0, 255 }; //needs to be BGRA becuse of emscripten
Uint32 frameStart, frameTime;
int FPS   = 60;
int DELAY = 1000.0f / FPS;
int current_fps = 0;
int current_fps_counter = 0;
Uint32 current_frameStart;
char fps_text[200];
float xLocation = 0.0f;
float yLocation = 0.0f;
unsigned int shaderProgram = 0;
char* loadFile(char* filename);
void limitFPS();
unsigned int initShaders();
char rom_name[100];
bool runApp = true;
int swapCount = 0;
int audioDeviceId = 0;
int vicount = 0;
int currentSwapCount = 0;
int audioBufferQueue = 0;
int currentAudioBufferQueue = 0;
int hadSkip = 0;
int currentHadSkip = 0;
int maxAudioBufferQueue = 0;
int currentMaxAudioBufferQueue = 0;
char toast_message[250];
int toastCounter = 0;

SDL_Window* WindowOpenGL;
void mainLoop();
bool isPressedOnce(bool condition, bool* lastPressedVar);
bool isReleasedOnce(bool condition, bool* lastPressedVar); 

GLuint imageOverlay;
void setupDrawTextOpenGL();
void drawTextOpenGL(const char* text, int x, int y, SDL_Color color, MY_FONT_SIZE fontsize);
void drawOpenglTexture(int x, int y, int w, int h, GLuint imageID);
GLuint loadOpenGLTexture(const char*);
unsigned int vertexBufferDrawText;
float positionsDrawText[] = {
        -1.0f, -1.0f, 0.0f, 1.0f,
        1.0f, -1.0f, 1.0f, 1.0f,
        1.0f, 1.0f, 1.0f, 0.0f,
        -1.0f, -1.0f, 0.0f, 1.0f,
        1.0f, 1.0f, 1.0f, 0.0f,
        -1.0f, 1.0f, 0.0f, 0.0f,
};
float positionsDrawTextFinal[] = {
        -1.0f, -1.0f, 0.0f, 1.0f,
        1.0f, -1.0f, 1.0f, 1.0f,
        1.0f, 1.0f, 1.0f, 0.0f,
        -1.0f, -1.0f, 0.0f, 1.0f,
        1.0f, 1.0f, 1.0f, 0.0f,
        -1.0f, 1.0f, 0.0f, 0.0f,
};

//gamepad
int Joy_Mapping_Up = 0;
int Joy_Mapping_Down = 0;
int Joy_Mapping_Left = 0;
int Joy_Mapping_Right = 0;
int Joy_Mapping_Action_A = 0;
int Joy_Mapping_Action_B = 0;
int Joy_Mapping_Action_Start = 0;
int Joy_Mapping_Action_Z = 0;
int Joy_Mapping_Action_L = 0;
int Joy_Mapping_Action_R = 0;
int Joy_Mapping_Menu = 0;
int Joy_Mapping_Action_CLEFT = 0;
int Joy_Mapping_Action_CRIGHT = 0;
int Joy_Mapping_Action_CUP = 0;
int Joy_Mapping_Action_CDOWN = 0;

//keyboard
int Mapping_Left = 0;
int Mapping_Right = 0;
int Mapping_Up = 0;
int Mapping_Down = 0;
int Mapping_Action_Start = 0;
int Mapping_Action_CUP = 0;
int Mapping_Action_CDOWN = 0;
int Mapping_Action_CLEFT = 0;
int Mapping_Action_CRIGHT = 0; 
int Mapping_Action_Z = 0;
int Mapping_Action_L = 0;
int Mapping_Action_R = 0;
int Mapping_Action_B = 0;
int Mapping_Action_A = 0;
int Mapping_Menu = 0;
int Mapping_Action_Analog_Up = 0;
int Mapping_Action_Analog_Down = 0;
int Mapping_Action_Analog_Left = 0;
int Mapping_Action_Analog_Right = 0;

int getKeyMapping(std::string line);

void readConfig()
{
    try
    {

        std::ifstream infile("config.txt");
        std::string line;

        std::size_t pos;
        std::string newstr;

        int counter = 0;
        while (std::getline(infile, line))
        {
            // printf("Counter: %d Line %s\n", counter, line.c_str());
            int mapping = atoi(line.c_str());

            if (counter==0) Joy_Mapping_Up = mapping;
            if (counter==1) Joy_Mapping_Down = mapping;
            if (counter==2) Joy_Mapping_Left = mapping;
            if (counter==3) Joy_Mapping_Right = mapping;
            if (counter==4) Joy_Mapping_Action_A = mapping;
            if (counter==5) Joy_Mapping_Action_B = mapping;
            if (counter==6) Joy_Mapping_Action_Start = mapping;
            if (counter==7) Joy_Mapping_Action_Z = mapping;
            if (counter==8) Joy_Mapping_Action_L = mapping;
            if (counter==9) Joy_Mapping_Action_R = mapping;
            if (counter==10) Joy_Mapping_Menu = mapping;
            if (counter==11) Joy_Mapping_Action_CLEFT = mapping;
            if (counter==12) Joy_Mapping_Action_CRIGHT = mapping;
            if (counter==13) Joy_Mapping_Action_CUP = mapping;
            if (counter==14) Joy_Mapping_Action_CDOWN = mapping;

            if (counter==15) Mapping_Left = getKeyMapping(line);
            if (counter==16) Mapping_Right = getKeyMapping(line);
            if (counter==17) Mapping_Up = getKeyMapping(line);
            if (counter==18) Mapping_Down = getKeyMapping(line);
            if (counter==19) Mapping_Action_Start = getKeyMapping(line);
            if (counter==20) Mapping_Action_CUP = getKeyMapping(line);
            if (counter==21) Mapping_Action_CDOWN = getKeyMapping(line);
            if (counter==22) Mapping_Action_CLEFT = getKeyMapping(line);
            if (counter==23) Mapping_Action_CRIGHT = getKeyMapping(line);
            if (counter==24) Mapping_Action_Z = getKeyMapping(line);
            if (counter==25) Mapping_Action_L = getKeyMapping(line);
            if (counter==26) Mapping_Action_R = getKeyMapping(line);
            if (counter==27) Mapping_Action_B = getKeyMapping(line);
            if (counter==28) Mapping_Action_A = getKeyMapping(line);
            if (counter==29) Mapping_Menu = getKeyMapping(line);
            if (counter==30) Mapping_Action_Analog_Up = getKeyMapping(line);
            if (counter==31) Mapping_Action_Analog_Down = getKeyMapping(line);
            if (counter==32) Mapping_Action_Analog_Left = getKeyMapping(line);
            if (counter==33) Mapping_Action_Analog_Right = getKeyMapping(line);

            //load eep file
            if (counter == 34)
            {
                if (mapping == 0)
                    loadEep = false;
                else
                    loadEep = true;
            }

            //load sra file
            if (counter == 35)
            {
                if (mapping == 0)
                    loadSra = false;
                else
                    loadSra = true;
            }

            //load fla file
            if (counter == 36)
            {
                if (mapping == 0)
                    loadFla = false;
                else
                    loadFla = true;
            }

            //show FPS
            if (counter == 37)
            {
                if (mapping == 1)
                    showFPS = true;
                else
                    showFPS = false;
            }

            //swap sticks
            if (counter == 38)
            {
                if (mapping == 1)
                    swapSticks = true;
                else
                    swapSticks = false;
            }

            //disable audio sync
            if (counter == 39)
            {
                if (mapping == 1)
                    disableAudioSync = true;
                else
                    disableAudioSync = false;
            }

            //player 2 invert Y axis
            if (counter == 40)
            {
                if (mapping == 1)
                    invert2P = true;
                else
                    invert2P = false;
            }

            //player 3 invert Y axis
            if (counter == 41)
            {
                if (mapping == 1)
                    invert3P = true;
                else
                    invert3P = false;
            }

            //player 4 invert Y axis
            if (counter == 42)
            {
                if (mapping == 1)
                    invert4P = true;
                else
                    invert4P = false;
            }

            //mobile mode
            if (counter == 43)
            {
                if (mapping == 1)
                    mobileMode = true;
                else
                    mobileMode = false;
            }

            //software renderer
            if (counter == 44)
            {
                if (mapping == 1)
                    forceAngry = true;
                else
                    forceAngry = false;

                printf("forceAngry: %d\n", forceAngry);
            }

            //mouse mode
            if (counter == 45)
            {
                if (mapping == 1)
                    mouseMode = true;
                else
                    mouseMode = false;
            }
            
            //use vbo
            if (counter == 46)
            {
                if (mapping == 1)
                    vbuf_use_vbo = true;
                else
                    vbuf_use_vbo = false;
            }

            counter++;


            //printf("Int %d\n", myint1);
            /*pos = line.find("ROM: ");
            if (pos == 0)
            {
                newstr = line.substr(pos + 5);
                sprintf(rom_name, "%s", newstr.c_str());
            }
            pos = line.find("WIDTH: ");
            if (pos == 0)
            {
                newstr = line.substr(pos + 7);
            }
            pos = line.find("HEIGHT: ");
            if (pos == 0)
            {
                newstr = line.substr(pos + 8);
            }*/
        }

        printf("Finished Reading Config\n");
    }
    catch (...)
    {
        printf("No Config File Found\n");
    }
}


void readCheats()
{

#ifdef _WIN32
    //for debugging cheats
    std::string testRom(rom_name);
    if (testRom != "roms\\fzero.v64")
        return;
#endif

    try
    {
        std::ifstream infile("cheat.txt");
        std::string line;
        std::size_t pos;
        std::string newstr;

        int counter = 0;
        while (std::getline(infile, line))
        {
            long long cheatAddress = std::stoll(line, nullptr, 16);
            std::getline(infile, line);
            int cheatValue = stoi(line, 0, 16);

            neilCheats[counter].address = cheatAddress;
            neilCheats[counter].value = cheatValue;
            
            counter++;
            neilCheatsLength = counter;

            if (counter == 256)
                return;
        }

        printf("Finished Reading Cheats\n");
    }
    catch (...)
    {
        printf("No Config File Found\n");
    }
}

//process mobile controls here
void processMobileControls()
{

#ifdef __EMSCRIPTEN__
	EM_ASM(
		myApp.rivetsData.inputController.updateMobileControls();
	);
#endif

}

#include "minizip/unzip.h"
#ifdef _WIN32
#include <direct.h>
#else
#include <sys/stat.h>
#endif

void extractZipFiles(const char* path)
{
    unzFile zip = unzOpen(path);
    if (unzGoToFirstFile(zip) == UNZ_OK)
    {
        do {
            if (unzOpenCurrentFile(zip) == UNZ_OK) {
                unz_file_info fileInfo;
                memset(&fileInfo, 0, sizeof(unz_file_info));

                if (unzGetCurrentFileInfo(zip, &fileInfo, NULL, 0, NULL, 0, NULL, 0) == UNZ_OK) {
                    char* filename = (char*)malloc(fileInfo.size_filename + 1);
                    unzGetCurrentFileInfo(zip, &fileInfo, filename, fileInfo.size_filename + 1, NULL, 0, NULL, 0);
                    filename[fileInfo.size_filename] = '\0';


                    if (fileInfo.uncompressed_size == 0) //directory
                    {
#ifdef _WIN32
                        _mkdir(filename);
#else
                        mkdir(filename, 0777);
#endif
                    }
                    else //file
                    {
                        void* buffer = malloc(fileInfo.uncompressed_size);
                        int readBytes = unzReadCurrentFile(zip, buffer, fileInfo.uncompressed_size);

                        FILE* file = fopen(filename, "wb");        // w for write, b for binary
                        fwrite(buffer, fileInfo.uncompressed_size, 1, file); // write 2048 bytes
                        fclose(file);
                        free(buffer);

                    }
                    
                    printf("File: %s\n", filename);
                    free(filename);
                }

                unzCloseCurrentFile(zip);
            }
        } while (unzGoToNextFile(zip) == UNZ_OK);
    }
}

int main(int argc, char* argv[])
{

#ifdef __EMSCRIPTEN__
    extractZipFiles("assets.zip");
#endif

    //use to view arguments
    // printf("arg count %d\n", argc);
    // for (int i = 0; i < argc; i++)
    // {
    //     printf("argc%d %s\n", i,argv[i]);
    // }


    Uint32 flags = SDL_INIT_VIDEO | SDL_INIT_JOYSTICK | SDL_INIT_GAMECONTROLLER | SDL_INIT_AUDIO;;

    if (SDL_Init(flags) < 0) {
        printf("Could not initialize SDL\n");
    }

    int WindowFlags = SDL_WINDOW_OPENGL;
    WindowOpenGL = SDL_CreateWindow(NULL,
        SDL_WINDOWPOS_UNDEFINED, SDL_WINDOWPOS_UNDEFINED, 640, 480, WindowFlags);

    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
    SDL_GLContext Context = SDL_GL_CreateContext(WindowOpenGL);


#ifndef __EMSCRIPTEN__
    SDL_AudioSpec AudioSettings = { 0 };

    AudioSettings.freq = 44100; 

    AudioSettings.format = AUDIO_S16;
    AudioSettings.channels = 2;
    SDL_AudioSpec AudioSettingsObtained = { 0 };
    SDL_AudioDeviceID deviceid = SDL_OpenAudioDevice(NULL, 0, &AudioSettings, &AudioSettingsObtained, 1);
    SDL_PauseAudioDevice(deviceid, 0);
    setDeviceId(deviceid);
    audioDeviceId = deviceid;
#endif

    //initialize font system
    TTF_Init();
    font24 = TTF_OpenFont("res/arial.ttf", 24);
    font40 = TTF_OpenFont("res/arial.ttf", 40);
    //TTF_SetFontStyle(font, TTF_STYLE_BOLD);

    //give it an initial value so drawText doesn't crash
    sprintf(fps_text, "FPS:");

#ifndef __EMSCRIPTEN__
        GLenum err = glewInit();
        if (GLEW_OK != err)
        {
            /* Problem: glewInit failed, something is seriously wrong. */
            printf("Error: %s\n", glewGetErrorString(err));
        }
        else
        {
            printf("GLEW Initialized\n");
        }
#endif

        //print OpenGL stats
        printf("VENDOR: %s\n", glGetString(GL_VENDOR));
        printf("RENDERER: %s\n", glGetString(GL_RENDERER));
        printf("VERSION: %s\n", glGetString(GL_VERSION));
        printf("GLSL: %s\n", glGetString(GL_SHADING_LANGUAGE_VERSION));

        setupDrawTextOpenGL();
        imageOverlay = loadOpenGLTexture("overlay.png");

        shaderProgram = initShaders();

        //clear the screen
        glClearColor(184.0f / 255.0f, 213.0f / 255.0f, 238.0f / 255.0f, 1.0f);
        glClear(GL_COLOR_BUFFER_BIT);
        SDL_GL_SwapWindow(WindowOpenGL);


    retro_init();

    sprintf(rom_name, "%s", "mario64.z64");
    //sprintf(rom_name, "%s", "roms\\mario64_europe.n64");
    //sprintf(rom_name, "%s", "roms\\fzero.v64");
    //sprintf(rom_name, "%s", "roms\\goldeneye.v64");
    //sprintf(rom_name, "%s", "roms\\diddy.v64");
    //sprintf(rom_name, "%s", "roms\\mariokart.v64");
    //sprintf(rom_name, "%s", "roms\\pilotwings.n64");
    //sprintf(rom_name, "%s", "roms\\drmario.z64");
    //sprintf(rom_name, "%s", "roms\\rogue_europe.z64");
    //sprintf(rom_name, "%s", "roms\\starcraft.z64");
    

    if (argc == 2)
    {
        sprintf(rom_name, "%s", argv[1]);
    }

    readConfig();
    readCheats();

    FILE* f = fopen(rom_name, "rb");
    fseek(f, 0, SEEK_END);
    int fsize = ftell(f);
    fseek(f, 0, SEEK_SET);  /* same as rewind(f); */

    uint8_t* filecontent = (uint8_t*)malloc(fsize);
    fread(filecontent, 1, fsize, f);
    fclose(f);

    bool loaded = retro_load_game_new(filecontent, fsize, loadEep, loadSra, loadFla);
    if (!loaded)
        printf("problem loading rom\n");

    FPS = getRegionTiming();
    DELAY = 1000.0f / FPS;
    
#ifdef __EMSCRIPTEN__
    if (disableAudioSync)
    {
        emscripten_set_main_loop(mainLoop, 0, 0);
    }
#else
    while (runApp){
		mainLoop();
	}

    retro_deinit();
    SDL_CloseAudio();
    SDL_Quit();
#endif
    return 0;
}

//overlay menu
void drawOverlay();
void processMenuItemButtons();
bool lastSaveStateKeyPressed = false;
bool lastLoadStateKeyPressed = false;
bool lastOverlayKeyPressed = false;
bool lastMenuUpKeyPressed = false;
bool lastMenuDownKeyPressed = false;
bool lastMenuOkKeyPressed = false;
bool lastOverlayButtonPressed = false;
bool lastMenuUpButtonPressed = false;
bool lastMenuDownButtonPressed = false;
bool lastMenuOkButtonPressed = false;
bool menuMoveUp = false;
bool menuMoveDown = false;
bool menuOk = false;
bool showOverlay = false;
char menuItems[][30] = {
    "New Rom",
    "Load State",
    "Save State",
    "Full Screen",
};
int selectedMenuItem = 0;

void resetNeilButtons()
{

    for (int i = 0; i < NEILNUMCONTROLLERS; i++)
    {
        neilbuttons[i].upKey = 0;
        neilbuttons[i].downKey = 0;
        neilbuttons[i].leftKey = 0;
        neilbuttons[i].rightKey = 0;
        neilbuttons[i].startKey = 0;
        neilbuttons[i].selectKey = 0;
        neilbuttons[i].lKey = 0;
        neilbuttons[i].rKey = 0;
        neilbuttons[i].zKey = 0;
        neilbuttons[i].aKey = 0;
        neilbuttons[i].bKey = 0;
        neilbuttons[i].axis0 = 0;
        neilbuttons[i].axis1 = 0;
        neilbuttons[i].axis2 = 0;
        neilbuttons[i].axis3 = 0;
        neilbuttons[i].cbLeft = 0;
        neilbuttons[i].cbRight = 0;
        neilbuttons[i].cbUp = 0;
        neilbuttons[i].cbDown = 0;
        neilbuttons[i].mouseX = 0;
        neilbuttons[i].mouseY = 0;
    }

}

void drawAngryOpenGL();

double fpsInterval = 1000.0 / 60.0;
int fpsThen = 0; //time in milliseconds
int fpsNow = 0; //time in milliseconds
int fpsFrameCounter = 0;
int fpsAudioRemaining = 0; //used to keep relieve some audio when emulator is running too fast

bool IsFrameReady() {

	fpsInterval = 1000.0 / (double)FPS; //uncomment this for variable FPS
	fpsNow = SDL_GetTicks();
	int elapsed = fpsNow - fpsThen;
	bool ready = true;

	int shouldBeFrames = (int)((double)elapsed / fpsInterval);
	if (fpsFrameCounter > shouldBeFrames)
	{
		ready = false;
	}

	if (ready)
		fpsFrameCounter++;

	//reset
	if (elapsed > 1000)
	{
		fpsThen = fpsNow;
		fpsFrameCounter = 0;
	}

	return ready;
}

void getMouseAccelCurve(int* mouseAxis) {

    int accCurve[] = {
        1, 10,
        2, 13,
        3, 16,
        4, 18,
        5, 21,
        6, 23,
        7, 25,
        8, 27,
        9, 29,
        10, 30,
        11, 31,
        12, 32,
        13, 33,
        14, 34,
        15, 35,
        16, 36,
        17, 37,
        18, 38,
        19, 39,
        20, 40,
    };

    int arrSize = sizeof(accCurve) / sizeof(accCurve[0]);

    int absVal = abs(*mouseAxis);
    int sign = *mouseAxis > 0 ? 1 : -1;

    if (absVal > accCurve[arrSize-2])
    {
        *mouseAxis = mouseRange*sign;
    }

    for(int i = 0; i < arrSize / 2; i++)
    {
        int key = accCurve[i*2];
        int val = accCurve[(i*2)+1];

        if (absVal == key) *mouseAxis = val*sign;
    }

    if (*mouseAxis>mouseRange) *mouseAxis = mouseRange;
    if (*mouseAxis<-mouseRange) *mouseAxis = -mouseRange;
}


void mainLoopInner();

void mainLoop()
{
    // ⚠ WHILE THE FRAME GATE IS ARMED THE CORE'S OWN LOOP MUST NOT ADVANCE THE
    // GUEST. This function is what emscripten_set_main_loop drives (armed
    // whenever disableAudioSync is set, which n64/index.html forces true) and
    // it is ALSO called from dist/script.js's ScriptProcessor onaudioprocess in
    // that same branch. Under lockstep the room decides when a frame runs, so
    // both of those drivers must become inert: a core that free-ran even one
    // rAF tick before the room's frame 0 is at a different guest position from
    // its peers, and two peers at different positions are desynced before
    // anybody has pressed anything. neil_ls_run_frame() is the only thing that
    // advances the guest from here on.
    if (g_ls_on) return;
    mainLoopInner();
    if (doubleSpeed)
    {
        mainLoopInner();
    }
}

static void timed_retro_run()
{
    double t0 = emscripten_get_now();
    retro_run();
    g_frame_cost_ms += emscripten_get_now() - t0;
    g_frame_cost_n++;
}

void mainLoopInner()
{
	#ifdef __EMSCRIPTEN__
	// ⚠ GATE A IS A WALL-CLOCK GATE, AND WALL CLOCK IS EXACTLY WHAT LOCKSTEP
	// MUST NOT DEPEND ON. IsFrameReady() is an SDL_GetTicks() budget, so on a
	// slow machine this returns without advancing the guest at all — meaning
	// "frame N" would be a different amount of emulated time on each peer. A
	// lockstep frame is driven by the room, not by this host's clock, so the
	// gate is lifted for the duration of that one frame and is otherwise
	// untouched.
	if (!g_ls_forcing && disableAudioSync && !doubleSpeed && !IsFrameReady())
		return;
	#endif

    SDL_Event windowEvent;
    frameStart = SDL_GetTicks();


    connectGamepad();

    resetNeilButtons();
    menuMoveUp = false;
    menuMoveDown = false;
    menuOk = false;

    //GAMEPAD
#ifdef USE_XINPUT
    for (int i = 0; i < NEILNUMCONTROLLERS; i++)
    {
        if (xControllers[i].connected)
        {
            //TESTING
            if (IsPressed(XINPUT_GAMEPAD_A, i)) neilbuttons[i].aKey = true;
            if (IsPressed(XINPUT_GAMEPAD_X, i)) neilbuttons[i].bKey = true;
            if (IsPressed(XINPUT_GAMEPAD_START, i)) neilbuttons[i].startKey = true;
            if (IsPressed(XINPUT_GAMEPAD_RIGHT_SHOULDER, i)) neilbuttons[i].rKey = true;
            if (IsPressed(XINPUT_GAMEPAD_LEFT_SHOULDER, i)) neilbuttons[i].zKey = true;
            if (xControllers[i].state.Gamepad.bLeftTrigger > 128) neilbuttons[i].lKey = true; //left trigger button


            //IMPLEMENT
            if (IsPressed(XINPUT_GAMEPAD_DPAD_UP, i)) neilbuttons[i].upKey = true;
            if (IsPressed(XINPUT_GAMEPAD_DPAD_DOWN, i)) neilbuttons[i].downKey = true;
            if (IsPressed(XINPUT_GAMEPAD_DPAD_LEFT, i)) neilbuttons[i].leftKey = true;
            if (IsPressed(XINPUT_GAMEPAD_DPAD_RIGHT, i)) neilbuttons[i].rightKey = true;

            if (swapSticks == 0)
            {
                neilbuttons[i].axis0 = xControllers[i].state.Gamepad.sThumbLX;
                neilbuttons[i].axis1 = xControllers[i].state.Gamepad.sThumbLY * -1;
                neilbuttons[i].axis2 = xControllers[i].state.Gamepad.sThumbRX;
                neilbuttons[i].axis3 = xControllers[i].state.Gamepad.sThumbRY;
            }
            else
            {
                neilbuttons[i].axis0 = xControllers[i].state.Gamepad.sThumbRX;
                neilbuttons[i].axis1 = xControllers[i].state.Gamepad.sThumbRY;
                neilbuttons[i].axis2 = xControllers[i].state.Gamepad.sThumbLX;
                neilbuttons[i].axis3 = xControllers[i].state.Gamepad.sThumbLY * -1;
            }

            if (i == 1 && invert2P)
            {
                neilbuttons[i].axis1 *= -1;
            }
            if (i == 2 && invert3P)
            {
                neilbuttons[i].axis1 *= -1;
            }
            if (i == 3 && invert4P)
            {
                neilbuttons[i].axis1 *= -1;
            }
            

            if (neilbuttons[i].axis2 < -16000) neilbuttons[i].cbLeft = 1;
            if (neilbuttons[i].axis2 > 16000) neilbuttons[i].cbRight = 1;
            if (neilbuttons[i].axis3 < -16000) neilbuttons[i].cbDown = 1;
            if (neilbuttons[i].axis3 > 16000) neilbuttons[i].cbUp = 1;

            //fix weird -1 * float conversion bug
            if (neilbuttons[i].axis1 == 0x8000)
            {
                neilbuttons[i].axis1--;
            }
        }
        

    }

    if (xControllers[0].connected)
    {
        if (isPressedOnce(IsPressed(XINPUT_GAMEPAD_RIGHT_THUMB, 0), &lastOverlayButtonPressed))
        {
            if (!showOverlay)
            {
                selectedMenuItem = 0;
            }
            showOverlay = !showOverlay;
        }
        if (isPressedOnce(IsPressed(XINPUT_GAMEPAD_DPAD_UP, 0), &lastMenuUpButtonPressed)) menuMoveUp = true;
        if (isPressedOnce(IsPressed(XINPUT_GAMEPAD_DPAD_DOWN, 0), &lastMenuDownButtonPressed)) menuMoveDown = true;
        if (isReleasedOnce(IsPressed(XINPUT_GAMEPAD_A, 0), &lastMenuOkButtonPressed)) menuOk = true;
    }
#endif

    for (int i = 0; i < NEILNUMCONTROLLERS; i++)
    {
        if (sdlJoysticks[i].gamepadConnected)
        {
            if (swapSticks == 0)
            {
                neilbuttons[i].axis0 = SDL_JoystickGetAxis(sdlJoysticks[i].joyStick, 0);
                neilbuttons[i].axis1 = SDL_JoystickGetAxis(sdlJoysticks[i].joyStick, 1);
                neilbuttons[i].axis2 = SDL_JoystickGetAxis(sdlJoysticks[i].joyStick, 2);
                neilbuttons[i].axis3 = SDL_JoystickGetAxis(sdlJoysticks[i].joyStick, 3);
            }
            else
            {
                neilbuttons[i].axis0 = SDL_JoystickGetAxis(sdlJoysticks[i].joyStick, 2);
                neilbuttons[i].axis1 = SDL_JoystickGetAxis(sdlJoysticks[i].joyStick, 3);
                neilbuttons[i].axis2 = SDL_JoystickGetAxis(sdlJoysticks[i].joyStick, 0);
                neilbuttons[i].axis3 = SDL_JoystickGetAxis(sdlJoysticks[i].joyStick, 1);
            }

            if (i == 1 && invert2P)
            {
                neilbuttons[i].axis1 *= -1;
            }
            if (i == 2 && invert3P)
            {
                neilbuttons[i].axis1 *= -1;
            }
            if (i == 3 && invert4P)
            {
                neilbuttons[i].axis1 *= -1;
            }
            

            if (neilbuttons[i].axis2 < -16000) neilbuttons[i].cbLeft = 1;
            if (neilbuttons[i].axis2 > 16000) neilbuttons[i].cbRight = 1;
            if (neilbuttons[i].axis3 < -16000) neilbuttons[i].cbUp = 1;
            if (neilbuttons[i].axis3 > 16000) neilbuttons[i].cbDown = 1;

            //neilbuttons.axis4 = SDL_JoystickGetAxis(joyStick, 4);
            //neilbuttons.axis5 = SDL_JoystickGetAxis(joyStick, 5);

#ifdef __EMSCRIPTEN__
            if (SDL_JoystickGetButton(sdlJoysticks[i].joyStick, Joy_Mapping_Up)) neilbuttons[i].upKey = true;
            if (SDL_JoystickGetButton(sdlJoysticks[i].joyStick, Joy_Mapping_Down)) neilbuttons[i].downKey = true;
            if (SDL_JoystickGetButton(sdlJoysticks[i].joyStick, Joy_Mapping_Left)) neilbuttons[i].leftKey = true;
            if (SDL_JoystickGetButton(sdlJoysticks[i].joyStick, Joy_Mapping_Right)) neilbuttons[i].rightKey = true;
            if (SDL_JoystickGetButton(sdlJoysticks[i].joyStick, Joy_Mapping_Action_A)) neilbuttons[i].aKey = true;
            if (SDL_JoystickGetButton(sdlJoysticks[i].joyStick, Joy_Mapping_Action_B)) neilbuttons[i].bKey = true;
            if (SDL_JoystickGetButton(sdlJoysticks[i].joyStick, Joy_Mapping_Action_Start)) neilbuttons[i].startKey = true;
            if (SDL_JoystickGetButton(sdlJoysticks[i].joyStick, Joy_Mapping_Action_Z)) neilbuttons[i].zKey = true;
            if (SDL_JoystickGetButton(sdlJoysticks[i].joyStick, Joy_Mapping_Action_L)) neilbuttons[i].lKey = true;
            if (SDL_JoystickGetButton(sdlJoysticks[i].joyStick, Joy_Mapping_Action_R)) neilbuttons[i].rKey = true;
            if (SDL_JoystickGetButton(sdlJoysticks[i].joyStick, Joy_Mapping_Action_CLEFT)) neilbuttons[i].cbLeft = true;
            if (SDL_JoystickGetButton(sdlJoysticks[i].joyStick, Joy_Mapping_Action_CRIGHT)) neilbuttons[i].cbRight = true;
            if (SDL_JoystickGetButton(sdlJoysticks[i].joyStick, Joy_Mapping_Action_CUP)) neilbuttons[i].cbUp = true;
            if (SDL_JoystickGetButton(sdlJoysticks[i].joyStick, Joy_Mapping_Action_CDOWN)) neilbuttons[i].cbDown = true;
            //only controller 1 controls the menu
            if (i == 0)
            {
                if (isPressedOnce(SDL_JoystickGetButton(sdlJoysticks[i].joyStick, Joy_Mapping_Menu), &lastOverlayButtonPressed))
                {
                    if (!showOverlay)
                    {
                        selectedMenuItem = 0;
                    }
                    showOverlay = !showOverlay;
                }
                if (isPressedOnce(SDL_JoystickGetButton(sdlJoysticks[i].joyStick, Joy_Mapping_Up), &lastMenuUpButtonPressed)) menuMoveUp = true;
                if (isPressedOnce(SDL_JoystickGetButton(sdlJoysticks[i].joyStick, Joy_Mapping_Down), &lastMenuDownButtonPressed)) menuMoveDown = true;
                if (isReleasedOnce(SDL_JoystickGetButton(sdlJoysticks[i].joyStick, Joy_Mapping_Action_A), &lastMenuOkButtonPressed)) menuOk = true;
            }
#endif
        }
    }

    if (mouseMode)
    {
        mousePressed = SDL_GetMouseState(&mouseX, &mouseY);
        SDL_GetRelativeMouseState(&mouseX, &mouseY);

        // printf("mouseX %d mouseY %d\n", mouseX, mouseY);
        getMouseAccelCurve(&mouseX);
        getMouseAccelCurve(&mouseY);

        int axis0Mouse = (int)(32760.0f*((float)mouseX/(float)mouseRange));
        int axis1Mouse = (int)(32760.0f*((float)mouseY/(float)mouseRange));

        if (mousePressed == 1)
            neilbuttons[0].aKey = true;
        if (mousePressed == 4)
            neilbuttons[0].bKey = true;

        neilbuttons[0].mouseX = mouseX;
        neilbuttons[0].mouseY = -mouseY;
    }


    //KEYBOARD
    keyboardState = (Uint8*)SDL_GetKeyboardState(NULL);

    if (keyboardState[Mapping_Up]) neilbuttons[0].upKey = true;
    if (keyboardState[Mapping_Down]) neilbuttons[0].downKey = true;
    if (keyboardState[Mapping_Left]) neilbuttons[0].leftKey = true;
    if (keyboardState[Mapping_Right]) neilbuttons[0].rightKey = true;

    if (keyboardState[Mapping_Action_Analog_Up]) neilbuttons[0].axis1 = -32000;
    if (keyboardState[Mapping_Action_Analog_Down]) neilbuttons[0].axis1 = 32000;
    if (keyboardState[Mapping_Action_Analog_Left]) neilbuttons[0].axis0 = -32000;
    if (keyboardState[Mapping_Action_Analog_Right]) neilbuttons[0].axis0 = 32000;

    if (keyboardState[Mapping_Action_Start]) neilbuttons[0].startKey = true;
    if (keyboardState[Mapping_Action_A]) neilbuttons[0].aKey = true;
    if (keyboardState[Mapping_Action_B]) neilbuttons[0].bKey = true;
    if (keyboardState[Mapping_Action_Z]) neilbuttons[0].zKey = true;
    if (keyboardState[Mapping_Action_R]) neilbuttons[0].rKey = true;
    if (keyboardState[Mapping_Action_L]) neilbuttons[0].lKey = true;

    //TODO C Buttons
    if (keyboardState[Mapping_Action_CLEFT]) neilbuttons[0].cbLeft = true;
    if (keyboardState[Mapping_Action_CDOWN]) neilbuttons[0].cbDown = true;
    if (keyboardState[Mapping_Action_CRIGHT]) neilbuttons[0].cbRight = true;
    if (keyboardState[Mapping_Action_CUP]) neilbuttons[0].cbUp = true;

    if (isPressedOnce(keyboardState[SDL_SCANCODE_GRAVE], &lastOverlayKeyPressed))
    {
        if (!showOverlay)
        {
            selectedMenuItem = 0;
        }
        showOverlay = !showOverlay;
    }
    if (isPressedOnce(keyboardState[SDL_SCANCODE_UP], &lastMenuUpKeyPressed)) menuMoveUp = true;
    if (isPressedOnce(keyboardState[SDL_SCANCODE_DOWN], &lastMenuDownKeyPressed)) menuMoveDown = true;
    if (isReleasedOnce(keyboardState[SDL_SCANCODE_RETURN], &lastMenuOkKeyPressed)) menuOk = true;


    //MOBILE
	if (mobileMode && !sdlJoysticks[0].gamepadConnected)
	{
		processMobileControls();
	}
    
    if (showOverlay)
    {
        resetNeilButtons(); //don't process game buttons while overlay is showing
        processMenuItemButtons();
    }

    // ---- LOCKSTEP: THE AGREED PAD IMAGE WINS, FOR EVERY SEATED PORT --------
    // Placed AFTER every local input source above (keyboard, SDL joystick,
    // mouse, mobile, and the overlay's own reset) because under lockstep the
    // input for this emulated frame is not this machine's opinion — it is the
    // room's, and it must be byte-identical on every peer. Anything that wrote
    // neilbuttons earlier in this function is deliberately overwritten.
    //
    // ⚠ THIS INCLUDES THIS PLAYER'S OWN PAD. Their bytes reach here through the
    // engine too, which is what keeps every machine computing the same frame
    // from the same inputs. The immediacy a player feels comes from the page
    // scheduling their own pad locally `delay` frames ahead, never from letting
    // a local read bypass the agreed image.
    if (g_ls_on)
    {
        for (int _p = 0; _p < NEILNUMCONTROLLERS; _p++)
            neilbuttons[_p] = g_ls_pads[_p];
    }


    if (SDL_PollEvent(&windowEvent) != 0)
    {
        if (windowEvent.type == SDL_QUIT)
        {
            runApp = false;
            return;
        }
    }


    if (doubleSpeed)
    {
        timed_retro_run();
    }
    else
    {
        //allow audio buffer to shrink down
        //if emulator is too far ahead
        // ⚠ GATE B SKIPS AN ENTIRE EMULATED FRAME based on how full the HOST's
        // audio queue is. Under lockstep that is a desync source of exactly the
        // same kind as Gate A above: one peer's audio backlog would silently
        // advance its guest one frame less than everybody else's. A lockstep
        // frame always runs its retro_run.
        audioBufferQueue = SDL_GetQueuedAudioSize(audioDeviceId);
        if (g_ls_forcing || (audioBufferQueue < 20000 && fpsAudioRemaining < 5000))
            timed_retro_run();
        else
        {
            hadSkip = 1;
            maxAudioBufferQueue = audioBufferQueue;
        }
    }



    if(getReadyToSwap()==1)
    {
        if (forceAngry)
        {
            glClearColor(184.0f / 255.0f, 213.0f / 255.0f, 238.0f / 255.0f, 1.0f);
            glClear(GL_COLOR_BUFFER_BIT);

            drawAngryOpenGL();
        }

        if (showOverlay)
        {
            drawOverlay();
        }

        //draw fps
        if (showFPS)
        {
            drawTextOpenGL(fps_text, 0, 0, fontcolorWhite, FONTSIZE_24);
        }

        if (toastCounter > 0)
        {
            drawTextOpenGL(toast_message, 0, 30, fontcolorWhite, FONTSIZE_24);
            toastCounter--;
        }
        
        //this only does something in the windows version
        SDL_GL_SwapWindow(WindowOpenGL);

        resetReadyToSwap();
        swapCount++;

        //for debugging pilotwings fix
        // triangleCount = 0;
        // globalTriangleTrigger++;
    }


    limitFPS();

#ifdef __EMSCRIPTEN__
    if (endframeCallback)
    {
        EM_ASM(
            myApp.localCallback();
        );
        endframeCallback = false;  
    }
#endif

}

bool isPressedOnce(bool condition, bool* lastPressedVar)
{
    if (condition)
    {
        if (!*lastPressedVar)
        {
            *lastPressedVar = true;
            return true;
        }
    }
    else
        *lastPressedVar = false;

    return false;
}


bool isReleasedOnce(bool condition, bool* lastPressedVar)
{
    bool wasReleased = false;
    if (condition)
    {
        *lastPressedVar = true;
    }
    else
    {
        if (*lastPressedVar)
        {
            wasReleased = true;
        }
        *lastPressedVar = false;
    }

    return wasReleased;
}

void processMenuItemButtons()
{
    int menuItemsCount = sizeof(menuItems) / 30;
    if (menuMoveDown) selectedMenuItem++;
    if (menuMoveUp) selectedMenuItem--;
    if (selectedMenuItem < 0) selectedMenuItem = 0;
    if (selectedMenuItem > menuItemsCount - 1) selectedMenuItem = menuItemsCount - 1;

    if (menuOk)
    {
#ifdef __EMSCRIPTEN__
        //"New Rom" - 0
        if (selectedMenuItem == 0)
        {
            EM_ASM(
                location.reload();
            );
        }
        
        //"Load State" - 1
        if (selectedMenuItem == 1)
        {
            EM_ASM(
                myApp.loadCloud();
            );
        }

        //"Save State" - 2
        if (selectedMenuItem == 2)
        {
            EM_ASM(
                myApp.saveCloud();
            );
        }

        //"Full Screen" - 3
        if (selectedMenuItem == 3)
        {
            EM_ASM(
                myApp.fullscreen();
            );
        }
#else
        //"Load State" - 1
        if (selectedMenuItem == 1)
        {
            neil_unserialize();
        }

        //"Save State" - 2
        if (selectedMenuItem == 2)
        {
            neil_serialize();
        }
#endif

        showOverlay = false;

    }
}


void drawOverlay()
{
    drawOpenglTexture(50, 50, 640 - 100, 480 - 100, imageOverlay);
    int menuItemsCount = sizeof(menuItems) / 30;
    int startX = 200;
    int startY = 480 - 120;

    for (int i = 0; i < menuItemsCount; i++)
    {
        int currentY = startY - (i * 80);
        if (i == selectedMenuItem)
        {
            drawTextOpenGL(">", startX -30, currentY, fontcolorRed, FONTSIZE_40);
        }
        drawTextOpenGL(menuItems[i], startX, currentY,fontcolorRed,FONTSIZE_40);
    }
}


void limitFPS()
{
    // Wait to mantain framerate:
    frameTime = SDL_GetTicks() - frameStart;
    if (frameTime < DELAY)
    {
#ifndef __EMSCRIPTEN__
        SDL_Delay((int)(DELAY - frameTime));
#endif
    }


    //calculate FPS
    current_fps_counter++;
    if (current_frameStart + 1000.0f < SDL_GetTicks())
    {
        current_fps = current_fps_counter; //host fps
        current_fps_counter = 0;
        current_frameStart = SDL_GetTicks();
        currentSwapCount = swapCount; //n64 fps


        //for debugging
        currentAudioBufferQueue = audioBufferQueue;
        swapCount = 0;
        currentHadSkip = hadSkip;
        hadSkip = 0;
        currentMaxAudioBufferQueue = maxAudioBufferQueue;
    }

    if (forceAngry)
        sprintf(fps_text, "FPS: %d", current_fps);
    else if (vbuf_use_vbo)
        sprintf(fps_text, "FPS: %d GameFPS: %d VBO", current_fps, currentSwapCount);
    else
        sprintf(fps_text, "FPS: %d GameFPS: %d", current_fps, currentSwapCount);

    //SDL_SetWindowTitle(WindowOpenGL, fps_text);

}


extern "C" {

    void runMainLoop(){
        mainLoop();
    }

    void toggleFPS(int show){
        if (show==1) showFPS = true;
        if (show==0) showFPS = false;
    }

}

char* loadFile(char* filename)
{
    FILE* f = fopen(filename, "rb");
    fseek(f, 0, SEEK_END);
    int fsize = ftell(f);
    fseek(f, 0, SEEK_SET);  /* same as rewind(f); */

    char* filecontent = (char*)malloc(fsize + 1);
    int readsize = fread(filecontent, 1, fsize, f);
    fclose(f);

    filecontent[readsize] = '\0';

    return filecontent;
}

unsigned int compileShader(int shaderType, char* source)
{
    unsigned int id = glCreateShader(shaderType);
    glShaderSource(id, 1, (const char**)&source, NULL);
    glCompileShader(id);

    //ERROR HANDLING
    int result;
    glGetShaderiv(id, GL_COMPILE_STATUS, &result);
    if (result == GL_FALSE)
    {
        int length;
        glGetShaderiv(id, GL_INFO_LOG_LENGTH, &length);
        char* message = (char*)alloca(length * sizeof(char));
        glGetShaderInfoLog(id, length, &length, message);
        if (shaderType == GL_VERTEX_SHADER)
            printf("FAILED TO COMPILE VERTEX SHADER + %s\n", message);
        if (shaderType == GL_FRAGMENT_SHADER)
            printf("FAILED TO COMPILE FRAGMENT SHADER + %s\n", message);

        glDeleteShader(id);
    }

    return id;
}

unsigned int initShaders()
{
    char* vertexSource = loadFile((char*)"shader_vert.hlsl");
    char* fragmentSource = loadFile((char*)"shader_frag.hlsl");

    unsigned int program = glCreateProgram();
    unsigned int vs = compileShader(GL_VERTEX_SHADER, vertexSource);
    unsigned int fs = compileShader(GL_FRAGMENT_SHADER, fragmentSource);

    glAttachShader(program, vs);
    glAttachShader(program, fs);
    glLinkProgram(program);
    glValidateProgram(program);

    glDeleteShader(vs);
    glDeleteShader(fs);

    return program;
}

void setupDrawTextOpenGL()
{
    //create the buffer
    glGenBuffers(1, &vertexBufferDrawText);
}

void translateDrawTextScreenCoordinates(int x, int y, int w, int h)
{
    float screenwidth = 640;
    float screenheight = 480;

    //openGL coordinates go from (-1,-1) to (1,1) as a square
    float newx = ((2.0f / (float)screenwidth) * (float)x) - 1.0f;
    float newy = ((2.0f / (float)screenheight) * (float)y) - 1.0f;
    float newwidth = ((2.0f / (float)screenwidth) * (float)w);
    float newheight = ((2.0f / (float)screenheight) * (float)h);

    for (int i = 0; i < 6; i++)
    {
        //handle X
        int tempX = positionsDrawText[i * 4];
        if (tempX < 0)
        {
            //convert it to x
            positionsDrawTextFinal[i * 4] = newx;
        }
        else
        {
            //convert it to x + w
            positionsDrawTextFinal[i * 4] = newx + newwidth;
        }

        //handle Y
        int tempY = positionsDrawText[(i * 4) + 1];
        if (tempY < 0)
        {
            //convert it to y
            positionsDrawTextFinal[(i * 4) + 1] = newy;
        }
        else
        {
            //convert it to y + h
            positionsDrawTextFinal[(i * 4) + 1] = newy + newheight;
        }

    }
}

//we use SDL's API to generate an image of the text but then
//we need to convert it into an OpenGL Texture
//NOTE - x and y start at the bottom left corner of the screen
void drawTextOpenGL(const char* text, int x, int y, SDL_Color color, MY_FONT_SIZE fontsize)
{
    //need this to enable transparency on the texture
    glEnable(GL_BLEND);
    glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);

    GLuint texture;
    glGenTextures(1, &texture);
    glBindTexture(GL_TEXTURE_2D, texture);

    TTF_Font* font = NULL;

    if (fontsize == FONTSIZE_24) font = font24;
    if (fontsize == FONTSIZE_40) font = font40;

    SDL_Surface* surface = TTF_RenderUTF8_Blended(font, text, color);

    //surface->w TEXTURE WIDTH
    //surface->h TEXTURE HEIGHT

    translateDrawTextScreenCoordinates(x, y, surface->w, surface->h);

    //we are technically using the same shader for 
    //drawTextOpenGL() and drawOpenglTexture() so this
    //code is nearly the same in both however 
    //keeping it in both in case I ever have seperate shaders
    glUseProgram(shaderProgram);

    //bind it or "select" it
    glBindBuffer(GL_ARRAY_BUFFER, vertexBufferDrawText);
    //fill the buffer with data
    glBufferData(GL_ARRAY_BUFFER, sizeof(float) * 24, positionsDrawTextFinal, GL_DYNAMIC_DRAW);

    //define the position attribute
    glVertexAttribPointer(
        0, //attribute number for shader
        2, //size or number of components for this attribute, so 2 floats for a position
        GL_FLOAT, //data type of each component
        GL_FALSE, //do we want it to auto normalize the data for us (or convert it to a range of 0-1)
        sizeof(float) * 4, //stride or number of bytes between each vertex
        (GLvoid*)0 //offset to this attribute - needs to be converted to a pointer (const void*)8 as an example
    );

    //texture coordinate
    glVertexAttribPointer(
        1, //attribute number for shader
        2, //size or number of components for this attribute, so 2 floats for a position
        GL_FLOAT, //data type of each component
        GL_FALSE, //do we want it to auto normalize the data for us (or convert it to a range of 0-1)
        sizeof(float) * 4, //stride or number of bytes between each vertex
        (GLvoid*)8 //offset to this attribute - needs to be converted to a pointer (const void*)8 as an example
    );


    //need to enable this attribute in this case 0th attribute (matches first parameter of glVertexAttribPointer above)
    glEnableVertexAttribArray(0);
    glEnableVertexAttribArray(1);


    char colors = surface->format->BytesPerPixel;
    int texture_format;

    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);

    //Emscripten doesn't support GL_BGRA ??
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, surface->w, surface->h, 0,
        GL_RGBA, GL_UNSIGNED_BYTE, surface->pixels);


    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, texture);

    //render the triangles
    glDrawArrays(
        GL_TRIANGLES, //what are we drawing
        0, //first index to draw
        6 //how many to draw
    );


    glDisable(GL_BLEND);


    glDeleteTextures(1, &texture);
    SDL_FreeSurface(surface);

    // //if we don't destroy this you will see in 
    // //windows task manager the memory will keep growing
    // SDL_DestroyTexture(fontTexture); 
}

void drawAngryOpenGL()
{
    //need this to enable transparency on the texture
    //glEnable(GL_BLEND);
    //glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);

    GLuint texture;
    glGenTextures(1, &texture);
    glBindTexture(GL_TEXTURE_2D, texture);

    translateDrawTextScreenCoordinates(0, 0, 640, 480);

    //we are technically using the same shader for 
    //drawTextOpenGL() and drawOpenglTexture() so this
    //code is nearly the same in both however 
    //keeping it in both in case I ever have seperate shaders
    glUseProgram(shaderProgram);

    //bind it or "select" it
    glBindBuffer(GL_ARRAY_BUFFER, vertexBufferDrawText);
    //fill the buffer with data
    glBufferData(GL_ARRAY_BUFFER, sizeof(float) * 24, positionsDrawTextFinal, GL_DYNAMIC_DRAW);

    //define the position attribute
    glVertexAttribPointer(
        0, //attribute number for shader
        2, //size or number of components for this attribute, so 2 floats for a position
        GL_FLOAT, //data type of each component
        GL_FALSE, //do we want it to auto normalize the data for us (or convert it to a range of 0-1)
        sizeof(float) * 4, //stride or number of bytes between each vertex
        (GLvoid*)0 //offset to this attribute - needs to be converted to a pointer (const void*)8 as an example
    );

    //texture coordinate
    glVertexAttribPointer(
        1, //attribute number for shader
        2, //size or number of components for this attribute, so 2 floats for a position
        GL_FLOAT, //data type of each component
        GL_FALSE, //do we want it to auto normalize the data for us (or convert it to a range of 0-1)
        sizeof(float) * 4, //stride or number of bytes between each vertex
        (GLvoid*)8 //offset to this attribute - needs to be converted to a pointer (const void*)8 as an example
    );


    //need to enable this attribute in this case 0th attribute (matches first parameter of glVertexAttribPointer above)
    glEnableVertexAttribArray(0);
    glEnableVertexAttribArray(1);


    int texture_format;

    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);

    //Emscripten doesn't support GL_BGRA ??
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, 640, angryVerticalResolution, 0,
        GL_RGBA, GL_UNSIGNED_BYTE, get_video_buffer());


    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, texture);

    //render the triangles
    glDrawArrays(
        GL_TRIANGLES, //what are we drawing
        0, //first index to draw
        6 //how many to draw
    );


    glDisable(GL_BLEND);


    glDeleteTextures(1, &texture);

    // //if we don't destroy this you will see in 
    // //windows task manager the memory will keep growing
    // SDL_DestroyTexture(fontTexture); 
}


GLuint loadOpenGLTexture(const char* file)
{
    GLuint imageID;

    int width = 0;
    int height = 0;
    int bpp = 0;
    unsigned char* localBuffer;

    //normally opengl draws things upside down
    //since the origin is at the bottom left
    //however we already flipped the texture coordinates
    //in positionsDrawText[] so we can load normally
    //otherwise you would pass 1 into this function
    stbi_set_flip_vertically_on_load(0);
    
    localBuffer = stbi_load(file, &width, &height, &bpp, 4);

    glGenTextures(1, &imageID);
    glBindTexture(GL_TEXTURE_2D, imageID);

    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);

    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, width, height, 0, GL_RGBA, GL_UNSIGNED_BYTE, localBuffer);

    if (localBuffer)
        stbi_image_free(localBuffer);

    return imageID;
}

void drawOpenglTexture(int x, int y, int w, int h, GLuint imageID)
{
    //need this to enable transparency on the texture
    glEnable(GL_BLEND);
    glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);

    translateDrawTextScreenCoordinates(x, y, w, h);

    glUseProgram(shaderProgram);

    //bind it or "select" it
    glBindBuffer(GL_ARRAY_BUFFER, vertexBufferDrawText);
    //fill the buffer with data
    glBufferData(GL_ARRAY_BUFFER, sizeof(float) * 24, positionsDrawTextFinal, GL_DYNAMIC_DRAW);

    //define the position attribute
    glVertexAttribPointer(
        0, //attribute number for shader
        2, //size or number of components for this attribute, so 2 floats for a position
        GL_FLOAT, //data type of each component
        GL_FALSE, //do we want it to auto normalize the data for us (or convert it to a range of 0-1)
        sizeof(float) * 4, //stride or number of bytes between each vertex
        (GLvoid*)0 //offset to this attribute - needs to be converted to a pointer (const void*)8 as an example
    );

    //texture coordinate
    glVertexAttribPointer(
        1, //attribute number for shader
        2, //size or number of components for this attribute, so 2 floats for a position
        GL_FLOAT, //data type of each component
        GL_FALSE, //do we want it to auto normalize the data for us (or convert it to a range of 0-1)
        sizeof(float) * 4, //stride or number of bytes between each vertex
        (GLvoid*)8 //offset to this attribute - needs to be converted to a pointer (const void*)8 as an example
    );


    //need to enable this attribute in this case 0th attribute (matches first parameter of glVertexAttribPointer above)
    glEnableVertexAttribArray(0);
    glEnableVertexAttribArray(1);


    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, imageID);

    //render the triangle
    glDrawArrays(
        GL_TRIANGLES, //what are we drawing
        0, //first index to draw
        6 //how many to draw
    );
    
}

int getKeyMapping(std::string line)
{
    //remove carriage return
    #ifdef __EMSCRIPTEN__
    line.erase(line.size() - 1);
    #endif

    if (line.compare("ArrowLeft")==0) return SDL_SCANCODE_LEFT;
    if (line.compare("ArrowRight")==0) return SDL_SCANCODE_RIGHT;
    if (line.compare("ArrowUp")==0) return SDL_SCANCODE_UP;
    if (line.compare("ArrowDown")==0) return SDL_SCANCODE_DOWN;
    if (line.compare("Enter")==0) return SDL_SCANCODE_RETURN;
    if (line.compare("a")==0) return SDL_SCANCODE_A;
    if (line.compare("b")==0) return SDL_SCANCODE_B;
    if (line.compare("c")==0) return SDL_SCANCODE_C;
    if (line.compare("d")==0) return SDL_SCANCODE_D;
    if (line.compare("e")==0) return SDL_SCANCODE_E;
    if (line.compare("f")==0) return SDL_SCANCODE_F;
    if (line.compare("g")==0) return SDL_SCANCODE_G;
    if (line.compare("h")==0) return SDL_SCANCODE_H;
    if (line.compare("i")==0) return SDL_SCANCODE_I;
    if (line.compare("j")==0) return SDL_SCANCODE_J;
    if (line.compare("k")==0) return SDL_SCANCODE_K;
    if (line.compare("l")==0) return SDL_SCANCODE_L;
    if (line.compare("m")==0) return SDL_SCANCODE_M;
    if (line.compare("n")==0) return SDL_SCANCODE_N;
    if (line.compare("o")==0) return SDL_SCANCODE_O;
    if (line.compare("p")==0) return SDL_SCANCODE_P;
    if (line.compare("q")==0) return SDL_SCANCODE_Q;
    if (line.compare("r")==0) return SDL_SCANCODE_R;
    if (line.compare("s")==0) return SDL_SCANCODE_S;
    if (line.compare("t")==0) return SDL_SCANCODE_T;
    if (line.compare("u")==0) return SDL_SCANCODE_U;
    if (line.compare("v")==0) return SDL_SCANCODE_V;
    if (line.compare("w")==0) return SDL_SCANCODE_W;
    if (line.compare("x")==0) return SDL_SCANCODE_X;
    if (line.compare("y")==0) return SDL_SCANCODE_Y;
    if (line.compare("z")==0) return SDL_SCANCODE_Z;
    if (line.compare("`")==0) return SDL_SCANCODE_GRAVE;
    if (line.compare("1") == 0) return SDL_SCANCODE_1;
    if (line.compare("2") == 0) return SDL_SCANCODE_2;
    if (line.compare("3") == 0) return SDL_SCANCODE_3;
    if (line.compare("4") == 0) return SDL_SCANCODE_4;
    if (line.compare("5") == 0) return SDL_SCANCODE_5;
    if (line.compare("6") == 0) return SDL_SCANCODE_6;
    if (line.compare("7") == 0) return SDL_SCANCODE_7;
    if (line.compare("8") == 0) return SDL_SCANCODE_8;
    if (line.compare("9") == 0) return SDL_SCANCODE_9;
    if (line.compare("0") == 0) return SDL_SCANCODE_0;
    if (line.compare(" ") == 0) return SDL_SCANCODE_SPACE;
    if (line.compare(",") == 0) return SDL_SCANCODE_COMMA;
    if (line.compare(".") == 0) return SDL_SCANCODE_PERIOD;
    if (line.compare("/") == 0) return SDL_SCANCODE_SLASH;
    if (line.compare(";") == 0) return SDL_SCANCODE_SEMICOLON;
    if (line.compare("'") == 0) return SDL_SCANCODE_APOSTROPHE;
    if (line.compare("[") == 0) return SDL_SCANCODE_LEFTBRACKET;
    if (line.compare("]") == 0) return SDL_SCANCODE_RIGHTBRACKET;
    if (line.compare("\\") == 0) return SDL_SCANCODE_BACKSLASH;
    if (line.compare("-") == 0) return SDL_SCANCODE_MINUS;
    if (line.compare("=") == 0) return SDL_SCANCODE_EQUALS;


    //default
    return 0;

}

extern "C" {

    void neil_toast_message(char* message)
    {
        sprintf(toast_message, message);
        toastCounter = 60;
    }
    	
    void neil_send_mobile_controls(char* controls, char* axis0, char* axis1) 
	{
        if (controls[0]=='1') neilbuttons[0].upKey = true;;
        if (controls[1]=='1') neilbuttons[0].downKey = true;
        if (controls[2]=='1') neilbuttons[0].leftKey = true;
        if (controls[3]=='1') neilbuttons[0].rightKey = true;
        if (controls[4]=='1') neilbuttons[0].aKey = true;
        if (controls[5]=='1') neilbuttons[0].bKey = true;
        if (controls[6]=='1') neilbuttons[0].startKey = true;
        if (controls[7]=='1') neilbuttons[0].zKey = true;
        if (controls[8]=='1') neilbuttons[0].lKey = true;
        if (controls[9]=='1') neilbuttons[0].rKey = true;
        if (controls[10]=='1') neilbuttons[0].cbUp = true;
        if (controls[11]=='1') neilbuttons[0].cbDown = true;
        if (controls[12]=='1') neilbuttons[0].cbLeft = true;
        if (controls[13]=='1') neilbuttons[0].cbRight = true;

        std::string axis0String(axis0);
        float axis0Float = std::stof(axis0String);
        neilbuttons[0].axis0 = (int)((float)32000*axis0Float);

        std::string axis1String(axis1);
        float axis1Float = std::stof(axis1String);
        neilbuttons[0].axis1 = -(int)((float)32000*axis1Float);

	}

    // ---- LOCKSTEP ENTRY POINTS ------------------------------------------
    // See the block above neilbuttons[] for why these exist. All three are
    // no-ops for a single player: nothing calls them unless a room formed.

    // Arm or release the frame gate. While armed the CORE'S OWN main loop must
    // not advance the guest — mainLoop() below returns immediately — because
    // this build starts emscripten_set_main_loop(mainLoop, 0, 0) whenever
    // disableAudioSync is set (which n64/index.html forces true), and a core
    // that free-ran even one rAF tick before the room's frame 0 is already at a
    // different guest position from its peers. Releasing hands the console back
    // so a player whose room ended keeps playing single-player from exactly the
    // frame they were holding, rather than being left staring at a still image.
    void neil_ls_arm(int on)
    {
        g_ls_on = on ? 1 : 0;
        for (int p = 0; p < NEILNUMCONTROLLERS; p++)
        {
            memset(&g_ls_pads[p], 0, sizeof(struct NeilButtons));
        }
    }

    int neil_ls_armed(void) { return g_ls_on; }

    // One seated port's pad for the frame that is about to run. `mask` is the
    // SAME 14-bit order neil_send_mobile_controls reads its control string in
    // (0 UP, 1 DOWN, 2 LEFT, 3 RIGHT, 4 A, 5 B, 6 START, 7 Z, 8 L, 9 R,
    // 10 C-UP, 11 C-DOWN, 12 C-LEFT, 13 C-RIGHT), so the wire format the
    // multiplayer page already speaks did not have to change.
    //
    // ⚠ THE ANALOG AXES ARE NOT DECORATION. Almost nothing on this console
    // walks on the d-pad — Mario, Banjo, Zelda and every kart are on the stick —
    // so a digital-only remote player would look connected and be unable to
    // take a step. ax/ay arrive already scaled to +/-32000 in the core's own
    // units, and ay is passed in the page's up-positive convention and negated
    // here exactly as neil_send_mobile_controls does, so the two paths cannot
    // disagree about which way is up.
    void neil_ls_set_pad(int port, int mask, int ax, int ay)
    {
        if (port < 0 || port >= NEILNUMCONTROLLERS) return;
        struct NeilButtons* b = &g_ls_pads[port];
        memset(b, 0, sizeof(struct NeilButtons));
        b->upKey     = (mask & (1 << 0))  ? 1 : 0;
        b->downKey   = (mask & (1 << 1))  ? 1 : 0;
        b->leftKey   = (mask & (1 << 2))  ? 1 : 0;
        b->rightKey  = (mask & (1 << 3))  ? 1 : 0;
        b->aKey      = (mask & (1 << 4))  ? 1 : 0;
        b->bKey      = (mask & (1 << 5))  ? 1 : 0;
        b->startKey  = (mask & (1 << 6))  ? 1 : 0;
        b->zKey      = (mask & (1 << 7))  ? 1 : 0;
        b->lKey      = (mask & (1 << 8))  ? 1 : 0;
        b->rKey      = (mask & (1 << 9))  ? 1 : 0;
        b->cbUp      = (mask & (1 << 10)) ? 1 : 0;
        b->cbDown    = (mask & (1 << 11)) ? 1 : 0;
        b->cbLeft    = (mask & (1 << 12)) ? 1 : 0;
        b->cbRight   = (mask & (1 << 13)) ? 1 : 0;
        b->axis0 = ax;
        b->axis1 = -ay;
    }

    // Run EXACTLY ONE emulated frame, unconditionally. This is the lockstep
    // quantum and it is a real one: with -DNO_LIBCO (Makefile:168) retro_run
    // steps r4300 until getVI_Count() > 0 (r4300.c:175-195), i.e. exactly one
    // VI field, so "frame N" means the same amount of emulated time on every
    // machine regardless of how fast the host is. g_ls_forcing lifts the two
    // wall-clock gates for this call only.
    void neil_ls_run_frame(void)
    {
        g_ls_forcing = 1;
        mainLoopInner();
        g_ls_forcing = 0;
    }

    void neil_set_buffer_remaining(int remaining)
	{
		fpsAudioRemaining = remaining;
	}

    void neil_set_endframe_callback()
	{
		endframeCallback = true;
	}

    void neil_set_double_speed(int set)
    {
        if (set)
            doubleSpeed = true;
        else
            doubleSpeed = false;
    }

    void neil_set_jit_bridge(int set)
    {
        g_jit_bridge = set;
    }

    double neil_frame_cost_ms(void) { return g_frame_cost_ms; }
    int neil_frame_cost_n(void) { return (int)g_frame_cost_n; }
    void neil_frame_cost_reset(void) { g_frame_cost_ms = 0.0; g_frame_cost_n = 0; }
}